import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { useLawSummary } from "../hooks/law-viewer/useLawSummary.js";
import { useI18n } from "../i18n/useI18n.js";
import { Button } from "./Button.jsx";
import { Chip } from "./ui/Chip.jsx";

function GoldSparkle({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0 text-eu-gold dark:text-eu-gold-bright">
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
    </svg>
  );
}

function CitationChips({ citations, onArticleClick, t }) {
  if (!citations?.length) return null;
  return citations.map((article) => (
    <Chip
      key={article}
      onClick={() => onArticleClick?.(article)}
      className="ml-1 align-baseline"
    >
      {t("lawViewer.artShort")} {article}
    </Chip>
  ));
}

function CitedText({ block, onArticleClick, t }) {
  if (!block?.text) return null;
  return (
    <span>
      {block.text}
      <CitationChips citations={block.citations} onArticleClick={onArticleClick} t={t} />
    </span>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-eu-gold-deep dark:text-eu-gold-bright">
      {children}
    </div>
  );
}

export function LawSummary({ celex, lang = "EN", onArticleClick, className = "rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900" }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(true);
  const { summary, metadata, loading, loaded, error, retry } = useLawSummary(celex);
  const showEnglishOnlyNote = (lang || "EN").toUpperCase() !== "EN";

  if (!celex) return null;
  // Imported laws outside the search index have summaries deliberately
  // disabled server-side; hide the panel instead of offering a retry.
  if (error?.code === "summary_not_indexed") return null;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 border-b border-gray-100 px-5 py-3 text-left dark:border-gray-800"
      >
        <GoldSparkle />
        <span className="font-semibold text-gray-900 dark:text-gray-100">{t("lawSummary.title")}</span>
        {showEnglishOnlyNote ? (
          <span className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {t("lawSummary.englishOnly")}
          </span>
        ) : null}
        <span className="ml-auto hidden shrink-0 text-[11.5px] text-gray-400 dark:text-gray-500 sm:inline">
          {t("lawSummary.verifyNote")}
        </span>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {open ? (
        <div className="space-y-4 px-5 py-4 text-sm leading-6 text-gray-700 dark:text-gray-300">
          {loading && !loaded ? (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              {t("lawSummary.generating")}
            </div>
          ) : null}

          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-300 pl-3 text-amber-800 dark:border-amber-700 dark:text-amber-200">
              <span>{t("lawSummary.unavailable")}</span>
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                <RefreshCw size={14} />
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          {summary ? (
            <>
              {summary.natureAndEffect?.text ? (
                <div>
                  <SectionLabel>{t("lawSummary.natureAndEffect")}</SectionLabel>
                  <p><CitedText block={summary.natureAndEffect} onArticleClick={onArticleClick} t={t} /></p>
                </div>
              ) : null}

              <div>
                <SectionLabel>{t("lawSummary.purpose")}</SectionLabel>
                <p><CitedText block={summary.purpose} onArticleClick={onArticleClick} t={t} /></p>
              </div>

              {summary.scope?.text ? (
                <div>
                  <SectionLabel>{t("lawSummary.scope")}</SectionLabel>
                  <p><CitedText block={summary.scope} onArticleClick={onArticleClick} t={t} /></p>
                </div>
              ) : null}

              {summary.keyPoints?.length ? (
                <div>
                  <SectionLabel>{t("lawSummary.keyPoints")}</SectionLabel>
                  <ul className="space-y-2">
                    {summary.keyPoints.map((item, index) => (
                      <li key={`${item.text}-${index}`} className="flex items-baseline gap-2.5">
                        <span className="h-1.5 w-1.5 shrink-0 translate-y-1 rounded-full bg-eu-gold dark:bg-eu-gold-bright" />
                        <span className="min-w-0 flex-1">{item.text}</span>
                        {item.citations?.length ? (
                          <span className="ml-auto shrink-0 space-x-1 pl-3 text-right">
                            {item.citations.map((article) => (
                              <Chip
                                key={article}
                                onClick={() => onArticleClick?.(article)}
                                className="align-baseline"
                              >
                                {t("lawViewer.artShort")} {article}
                              </Chip>
                            ))}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {metadata?.generatedAt ? (
                <div className="pt-1 text-[11px] text-gray-400 dark:text-gray-500">
                  {t("lawSummary.generatedOn", {
                    date: new Date(metadata.generatedAt).toLocaleDateString(locale === "en" ? "en-GB" : locale),
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
