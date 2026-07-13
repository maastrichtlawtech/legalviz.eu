import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Scale, Sparkles } from "lucide-react";
import { fetchCaseLawDigest } from "../utils/formexApi.js";
import { useI18n } from "../i18n/useI18n.js";
import { Button } from "./Button.jsx";
import { JudgmentCite } from "./ArticleCaseLawDigest.jsx";

/**
 * Whole-law AI digest of the CJEU case law interpreting an act. Generation is
 * on-demand (explicit button) and the result is cached server-side, so repeat
 * viewers of the same law get an instant cache hit.
 */
export function CaseLawDigest({ celex, currentLang = "EN" }) {
  const { t } = useI18n();
  const [requested, setRequested] = useState(false);
  const [digest, setDigest] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  // Reset when the law or language changes.
  useEffect(() => {
    setRequested(false);
    setDigest(null);
    setMetadata(null);
    setLoaded(false);
    setLoading(false);
    setError(null);
  }, [celex, currentLang]);

  useEffect(() => {
    if (!requested || !celex || loaded) return;
    let cancelled = false;

    setLoading(true);
    fetchCaseLawDigest(celex, currentLang)
      .then((payload) => {
        if (cancelled) return;
        setDigest(payload.digest || null);
        setMetadata({
          model: payload.model || null,
          cached: Boolean(payload.cached),
          generatedAt: payload.generatedAt || null,
        });
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setDigest(null);
        setMetadata(null);
        setLoaded(true);
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [celex, currentLang, requested, loaded]);

  const retry = useCallback(() => {
    setError(null);
    setLoaded(false);
  }, []);

  if (!celex) return null;

  // Idle: show the generate button.
  if (!requested) {
    return (
      <button
        type="button"
        onClick={() => setRequested(true)}
        className="mb-3 flex w-full items-center justify-between gap-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-left text-sm transition hover:border-teal-300 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:hover:border-teal-700 dark:hover:bg-teal-950/70"
      >
        <span className="inline-flex min-w-0 items-center gap-2 font-medium text-teal-900 dark:text-teal-100">
          <Sparkles size={14} className="shrink-0 text-teal-700 dark:text-teal-300" />
          <span>{t("caseLawDigest.generate")}</span>
        </span>
        <span className="shrink-0 rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-800 dark:bg-teal-900/50 dark:text-teal-200">
          {t("common.ai")}
        </span>
      </button>
    );
  }

  // Requested but the model found nothing groundable — stay quiet rather than
  // showing an empty box.
  if (loaded && !error && (!digest || digest.noCaseLaw)) return null;

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      {loading && !loaded ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          {t("caseLawDigest.generating")}
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-300 pl-3 text-sm text-amber-800 dark:border-amber-700 dark:text-amber-200">
          <span>{t("caseLawDigest.unavailable")}</span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw size={14} />
            {t("common.retry")}
          </Button>
        </div>
      ) : null}

      {digest && !digest.noCaseLaw ? (
        <div className="space-y-3 text-sm leading-6 text-gray-700 dark:text-gray-300">
          <div className="flex items-start gap-2">
            <Scale size={16} className="mt-0.5 shrink-0 text-teal-700 dark:text-teal-300" />
            <p>{digest.summary}</p>
          </div>

          {digest.themes?.length ? (
            <div className="space-y-3">
              {digest.themes.map((theme, index) => (
                <div key={`${theme.name}-${index}`} className="pl-6">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">{theme.name}</div>
                  <p>{theme.description}</p>
                  {theme.cites?.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {theme.cites.map((cite, citeIndex) => (
                        <JudgmentCite key={`${cite.ecli || cite.celex}-${cite.declarationNumber || citeIndex}`} cite={cite} currentLang={currentLang} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {metadata?.generatedAt ? (
            <div className="pl-6 text-[11px] text-gray-400 dark:text-gray-500">
              {t("caseLawDigest.generatedOn", { date: new Date(metadata.generatedAt).toLocaleDateString("en-GB") })}
              {metadata.cached ? ` ${t("caseLawDigest.fromCache")}` : ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
