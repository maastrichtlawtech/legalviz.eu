import { useEffect, useState } from "react";
import {
  fetchFormex,
  fetchParsedLaw,
  fetchRecitalTitles,
  getCachedLawPayload,
  cacheParsedLaw,
} from "../../utils/formexApi.js";
import { parseLawPayloadToCombined } from "../../utils/parsers.js";
import { EMPTY_LAW_DATA } from "../../utils/law-viewer/constants.js";
import { getLoadErrorDetails, isMissingStructuredLawText } from "../../utils/law-viewer/errors.js";

function applyRecitalTitles(data, titles) {
  if (!data?.recitals?.length || !titles || typeof titles !== "object") return data;
  let changed = false;
  const recitals = data.recitals.map((recital) => {
    const title = titles[String(recital.recital_number)];
    if (!title || title === recital.recital_title) return recital;
    changed = true;
    return { ...recital, recital_title: title };
  });
  return changed ? { ...data, recitals } : data;
}

export function useSecondaryLawDocument({ celex, secondaryLang, t }) {
  const [data, setData] = useState(EMPTY_LAW_DATA);
  const [loading, setLoading] = useState(false);
  const [recitalTitlesLoading, setRecitalTitlesLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!celex || !secondaryLang) {
      setData(EMPTY_LAW_DATA);
      setLoadError(null);
      setLoading(false);
      setRecitalTitlesLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setRecitalTitlesLoading(false);
    setLoadError(null);
    setData(EMPTY_LAW_DATA);

    (async () => {
      try {
        let nextData = null;
        const cached = await getCachedLawPayload(celex, secondaryLang);
        if (cached) {
          nextData = parseLawPayloadToCombined(cached);
        } else {
          try {
            const xmlText = await fetchFormex(celex, secondaryLang);
            nextData = parseLawPayloadToCombined(xmlText);
            cacheParsedLaw(celex, secondaryLang, nextData, xmlText);
          } catch (error) {
            if (!isMissingStructuredLawText(error)) {
              throw error;
            }
            nextData = parseLawPayloadToCombined(await fetchParsedLaw(celex, secondaryLang));
          }
        }

        if (!cancelled) setData(nextData);

        if (nextData.recitals?.length > 0) {
          setRecitalTitlesLoading(true);
          fetchRecitalTitles(celex, secondaryLang)
            .then((payload) => {
              if (cancelled) return;
              setData((current) => applyRecitalTitles(current, payload?.titles));
            })
            .catch(() => {
              // Recital titles are an enhancement; side-by-side text remains usable without them.
            })
            .finally(() => {
              if (!cancelled) setRecitalTitlesLoading(false);
            });
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(getLoadErrorDetails(error, t));
        setData(EMPTY_LAW_DATA);
        setRecitalTitlesLoading(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })()
      .catch(() => {
        // handled in async IIFE
      });

    return () => {
      cancelled = true;
    };
  }, [celex, secondaryLang, t]);

  return {
    data,
    loading,
    recitalTitlesLoading,
    loadError,
  };
}
