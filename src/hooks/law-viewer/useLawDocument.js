import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFormex, fetchParsedLaw, fetchRecitalTitles, getCachedLawPayload } from "../../utils/formexApi.js";
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

export function useLawDocument({ celex, lang, t, enabled = true }) {
  const [data, setData] = useState(EMPTY_LAW_DATA);
  const [loading, setLoading] = useState(false);
  const [recitalTitlesLoading, setRecitalTitlesLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled || !celex) {
      setData(EMPTY_LAW_DATA);
      setLoading(false);
      setRecitalTitlesLoading(false);
      setLoadError(null);
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setRecitalTitlesLoading(false);
    setLoadError(null);
    setData(EMPTY_LAW_DATA);

    try {
      let nextData = null;
      const cached = await getCachedLawPayload(celex, lang);
      if (cached) {
        nextData = parseLawPayloadToCombined(cached);
      } else {
        try {
          const text = await fetchFormex(celex, lang);
          nextData = parseLawPayloadToCombined(text);
        } catch (error) {
          if (!isMissingStructuredLawText(error)) {
            throw error;
          }
          nextData = parseLawPayloadToCombined(await fetchParsedLaw(celex, lang));
        }
      }

      if (requestRef.current !== requestId) return;
      // Tag the loaded document with the celex it belongs to so consumers can
      // tell whether `data` matches the currently requested law.  Without this,
      // a stale document (from the previously viewed law) can be mistaken for
      // the newly requested one during the render before the refetch lands.
      setData({ ...nextData, celex });

      if (nextData.recitals?.length > 0) {
        setRecitalTitlesLoading(true);
        fetchRecitalTitles(celex, lang)
          .then((payload) => {
            if (requestRef.current !== requestId) return;
            setData((current) => applyRecitalTitles(current, payload?.titles));
          })
          .catch(() => {
            // Recital titles are an enhancement; the law remains usable without them.
          })
          .finally(() => {
            if (requestRef.current === requestId) setRecitalTitlesLoading(false);
          });
      }
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setLoadError(getLoadErrorDetails(error, t));
      setData(EMPTY_LAW_DATA);
      setRecitalTitlesLoading(false);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [celex, enabled, lang, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  return {
    data,
    loading,
    recitalTitlesLoading,
    loadError,
    reload,
  };
}
