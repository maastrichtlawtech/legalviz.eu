import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Scale } from "lucide-react";
import { fetchArticleCaseLawDigest } from "../utils/formexApi.js";

function JudgmentCite({ cite, currentLang }) {
  if (!cite?.celex && !cite?.ecli) return null;
  const label = cite.ecli || cite.celex;
  const suffix = cite.declarationNumber ? ` §${cite.declarationNumber}` : "";
  const href = cite.celex
    ? `https://eur-lex.europa.eu/legal-content/${currentLang || "EN"}/TXT/?uri=CELEX:${cite.celex}`
    : null;

  const content = (
    <>
      {label}{suffix}
      {href ? <ExternalLink size={10} /> : null}
    </>
  );

  if (!href) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
        {content}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-teal-700 transition hover:border-teal-300 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:border-teal-700"
    >
      {content}
    </a>
  );
}

export function ArticleCaseLawDigest({ celex, articleNumber, currentLang = "EN", enabled = true }) {
  const [digest, setDigest] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDigest(null);
    setMetadata(null);
    setLoaded(false);
    setLoading(false);
    setError(null);
  }, [celex, articleNumber, currentLang]);

  useEffect(() => {
    if (!enabled || !celex || !articleNumber || loaded) return;
    const ctrl = new AbortController();
    let cancelled = false;

    setLoading(true);
    fetchArticleCaseLawDigest(celex, articleNumber, currentLang, { signal: ctrl.signal })
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
        if (cancelled || err.name === "AbortError") return;
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
      ctrl.abort();
    };
  }, [celex, articleNumber, currentLang, enabled, loaded]);

  if (!enabled) return null;
  if (digest?.noCaseLaw) return null;

  return (
    <div className="border-b border-gray-200 py-4 dark:border-gray-800">
      {loading && !loaded ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Generating case-law digest
        </div>
      ) : null}

      {error ? (
        <div className="border-l-2 border-amber-300 pl-3 text-sm text-amber-800 dark:border-amber-700 dark:text-amber-200">
          Case-law digest is not available yet.
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
              Static digest generated {new Date(metadata.generatedAt).toLocaleDateString("en-GB")}
              {metadata.cached ? " from cache" : ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
