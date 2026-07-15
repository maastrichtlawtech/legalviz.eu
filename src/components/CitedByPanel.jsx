import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp, Link2, Loader2, RefreshCw, Scale } from "lucide-react";
import { useI18n } from "../i18n/useI18n.js";
import { fetchArticleCitedBy } from "../utils/formexApi.js";
import { Button } from "./Button.jsx";
import { JudgmentCite } from "./ArticleCaseLawDigest.jsx";
import { buildCitedByDisplay, isCitedByUnavailableError } from "./citedByDisplay.js";

export function CitedByPanel({ celex, articleNumber, currentLang = "EN", onOpenLaw }) {
  const { t } = useI18n();
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [suppressed, setSuppressed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setPayload(null);
    setLoading(false);
    setLoaded(false);
    setError(null);
    setSuppressed(false);
    setExpanded(false);
  }, [celex, articleNumber]);

  useEffect(() => {
    if (!celex || !articleNumber || loaded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuppressed(false);

    fetchArticleCitedBy(celex, articleNumber)
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        setLoaded(true);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setPayload(null);
        setLoaded(true);
        if (isCitedByUnavailableError(nextError)) {
          setSuppressed(true);
        } else {
          setError(nextError);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [articleNumber, celex, loaded]);

  const retry = useCallback(() => {
    setError(null);
    setLoaded(false);
  }, []);

  const display = useMemo(() => buildCitedByDisplay(payload, {
    expanded,
    formatUnitLabel: (unitType, unit) => (
      ["article", "recital", "annex"].includes(unitType)
        ? t(`citedBy.unit.${unitType}`, { n: unit })
        : String(unit ?? "")
    ),
    formatReference: (article, reference) => {
      const paragraph = reference?.paragraph == null || String(reference.paragraph).trim() === ""
        ? ""
        : `(${String(reference.paragraph).trim()})`;
      const point = reference?.point == null || String(reference.point).trim() === ""
        ? ""
        : `(${String(reference.point).trim()})`;
      return t("citedBy.reference", { article, paragraph, point });
    },
  }), [expanded, payload, t]);

  if (!celex || !articleNumber || suppressed) return null;

  if (loading && !loaded) {
    return (
      <div className="mt-6 px-6 md:px-12">
        <div className="flex items-center justify-between gap-3 border-y border-gray-200 py-3 dark:border-gray-800">
          <span className="flex min-w-0 items-center gap-2">
            <Link2 size={16} className="shrink-0 text-teal-700 dark:text-teal-300" />
            <span className="font-semibold text-gray-900 dark:text-gray-100">{t("citedBy.title")}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            {t("citedBy.loading")}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-6 px-6 md:px-12">
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-amber-300 py-3 text-sm text-amber-800 dark:border-amber-700 dark:text-amber-200">
          <span>{t("citedBy.unavailable")}</span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw size={14} />
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!loaded || !payload) return null;

  return (
    <div className="mt-6 px-6 md:px-12">
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-gray-200 py-3 dark:border-gray-800">
        <span className="flex min-w-0 items-center gap-2">
          <Link2 size={16} className="shrink-0 text-teal-700 dark:text-teal-300" />
          <span className="font-semibold text-gray-900 dark:text-gray-100">{t("citedBy.title")}</span>
          <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-sm font-medium text-teal-800 dark:bg-teal-900/40 dark:text-teal-200">
            {display.counts.total}
          </span>
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400">{t("citedBy.subtitle")}</span>
      </div>

      {display.empty ? (
        <p className="border-b border-gray-200 py-3 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          {t("citedBy.empty")}
        </p>
      ) : (
        <>
          {display.visibleProvisions.length ? (
            <section aria-labelledby="cited-by-legislation-heading" className="border-b border-gray-200 py-3 dark:border-gray-800">
              <h3 id="cited-by-legislation-heading" className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <BookOpen size={13} />
                {t("citedBy.legislationLabel", { count: display.counts.provisions })}
              </h3>
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {display.visibleProvisions.map((source, index) => {
                  const lawLabel = source.title || source.celex;
                  return (
                    <button
                      key={`${source.celex}-${source.unitType}-${source.unit}-${index}`}
                      type="button"
                      className="flex w-full items-start justify-between gap-4 rounded-sm px-1 py-2.5 text-left transition hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 dark:hover:bg-teal-950/30 dark:focus-visible:ring-teal-400 dark:focus-visible:ring-offset-gray-900"
                      aria-label={t("citedBy.openLaw", { law: lawLabel, unit: source.unitLabel })}
                      onClick={() => onOpenLaw?.(source.celex, {
                        articleNumber: source.articleNumber,
                        label: source.title,
                      })}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-gray-900 dark:text-gray-100">{lawLabel}</span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">{source.unitLabel}</span>
                      </span>
                      {source.referenceChips.length ? (
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {source.referenceChips.map((chip) => (
                            <span key={chip} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">{chip}</span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {display.visibleJudgments.length ? (
            <section aria-labelledby="cited-by-judgments-heading" className="border-b border-gray-200 py-3 dark:border-gray-800">
              <h3 id="cited-by-judgments-heading" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <Scale size={13} />
                {t("citedBy.judgmentsLabel", { count: display.counts.judgments })}
              </h3>
              <div className="flex flex-wrap gap-2">
                {display.visibleJudgments.map((judgment, index) => (
                  <JudgmentCite key={`${judgment.celex || judgment.ecli}-${index}`} cite={judgment} currentLang={currentLang} />
                ))}
              </div>
            </section>
          ) : null}

          {display.hasHiddenResults || expanded ? (
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 border-b border-gray-200 py-3 text-left text-sm font-medium text-teal-700 transition hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 dark:border-gray-800 dark:text-teal-300 dark:hover:text-teal-100 dark:focus-visible:ring-teal-400 dark:focus-visible:ring-offset-gray-900"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <span>{expanded ? t("citedBy.showLess") : t("citedBy.showAll", { count: display.returnedCount })}</span>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : null}

          {display.overflowCount > 0 ? (
            <p className="border-b border-gray-200 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              {t("citedBy.andMore", { count: display.overflowCount })}
            </p>
          ) : null}
        </>
      )}

      <p className="py-2 text-[11px] leading-5 text-gray-400 dark:text-gray-500">{t("citedBy.footnote")}</p>
    </div>
  );
}
