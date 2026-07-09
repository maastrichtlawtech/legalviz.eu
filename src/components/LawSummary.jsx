import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useLawSummary } from "../hooks/law-viewer/useLawSummary.js";
import { useI18n } from "../i18n/useI18n.js";
import { Button } from "./Button.jsx";

function CitationChips({ citations, onArticleClick }) {
  if (!citations?.length) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {citations.map((article) => (
        <button
          key={article}
          type="button"
          onClick={() => onArticleClick?.(article)}
          className="inline-flex items-center rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-blue-700 transition hover:border-blue-300 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:border-blue-700"
        >
          Art. {article}
        </button>
      ))}
    </span>
  );
}

function CitedText({ block, onArticleClick }) {
  if (!block?.text) return null;
  return (
    <span>
      {block.text}
      <CitationChips citations={block.citations} onArticleClick={onArticleClick} />
    </span>
  );
}

export function LawSummary({ celex, lang = "EN", onArticleClick, className = "mb-6 border-y border-blue-100 py-3 dark:border-blue-950/70" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const { summary, metadata, loading, loaded, error, retry } = useLawSummary(celex, { lang });

  if (!celex) return null;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles size={16} className="shrink-0 text-blue-700 dark:text-blue-300" />
          <span className="font-semibold text-gray-900 dark:text-gray-100">AI Overview</span>
        </span>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {open ? (
        <div className="mt-4 space-y-4 text-sm leading-6 text-gray-700 dark:text-gray-300">
          {loading && !loaded ? (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              Generating overview
            </div>
          ) : null}

          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-300 pl-3 text-amber-800 dark:border-amber-700 dark:text-amber-200">
              <span>Overview is not available for this law yet.</span>
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                <RefreshCw size={14} />
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          {summary ? (
            <>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Purpose</div>
                <p><CitedText block={summary.purpose} onArticleClick={onArticleClick} /></p>
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Scope</div>
                <p><CitedText block={summary.scope} onArticleClick={onArticleClick} /></p>
              </div>

              {summary.keyObligations?.length ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Key Points</div>
                  <ul className="space-y-1.5">
                    {summary.keyObligations.map((item, index) => (
                      <li key={`${item.text}-${index}`} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400" />
                        <span><CitedText block={item} onArticleClick={onArticleClick} /></span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {summary.structure ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Structure</div>
                  <p>{summary.structure}</p>
                </div>
              ) : null}

              {summary.relatedInstruments?.length ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Related Instruments</div>
                  <ul className="space-y-1.5">
                    {summary.relatedInstruments.map((item, index) => (
                      <li key={`${item.label}-${index}`}>
                        <span className="font-medium text-gray-900 dark:text-gray-100">{item.label}</span>
                        {item.celex ? <span className="ml-1 font-mono text-xs text-gray-500 dark:text-gray-400">{item.celex}</span> : null}
                        {item.relationship ? <span> — {item.relationship}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {metadata?.generatedAt ? (
                <div className="pt-1 text-[11px] text-gray-400 dark:text-gray-500">
                  Static summary generated {new Date(metadata.generatedAt).toLocaleDateString("en-GB")}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
