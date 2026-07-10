import React, { useState, useMemo, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Search, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "../i18n/useI18n.js";
import { CaseLawDigest } from "./CaseLawDigest.jsx";

const PAGE_SIZE = 20;

function formatDate(isoDate) {
  if (!isoDate) return null;
  try {
    return new Date(isoDate).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}

const MAX_VISIBLE_ARTICLES = 5;

function CaseCard({ c, currentLang }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showAllArticles, setShowAllArticles] = useState(false);
  const eurlexUrl = `https://eur-lex.europa.eu/legal-content/${currentLang || "EN"}/TXT/?uri=CELEX:${c.celex}`;
  const dateLabel = formatDate(c.date);
  const hasDecision = c.declarations && c.declarations.length > 0;
  const hasArticles = c.articlesCited && c.articlesCited.length > 0;
  const hiddenArticleCount = hasArticles ? Math.max(0, c.articlesCited.length - MAX_VISIBLE_ARTICLES) : 0;
  const visibleArticles = hasArticles
    ? (showAllArticles ? c.articlesCited : c.articlesCited.slice(0, MAX_VISIBLE_ARTICLES))
    : [];

  return (
    <li className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* Header row — always visible */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300">
            CJEU
          </span>
          {dateLabel && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
              {dateLabel}
            </span>
          )}
        </div>

        {/* Case number + full party name */}
        <div className="mt-1 text-xs">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {c.caseNumber || c.celex}
          </span>
          {c.name && (
            <span className="text-gray-500 dark:text-gray-400"> — {c.name}</span>
          )}
        </div>

        {/* Article pills — collapsed by default */}
        {hasArticles && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {visibleArticles.map((art, i) => (
              <span
                key={i}
                className="inline-block rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              >
                {art}
              </span>
            ))}
            {hiddenArticleCount > 0 && !showAllArticles && (
              <button
                type="button"
                onClick={() => setShowAllArticles(true)}
                className="inline-block rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600 transition-colors"
              >
                {t("metadata.caseLawMoreArticles", { count: hiddenArticleCount })}
              </button>
            )}
          </div>
        )}

        {/* Decision preview / expanded */}
        {hasDecision && (
          <div className="mt-2">
            {!expanded ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full text-left"
              >
                <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">{t("metadata.caseLawDecisionLabel")}</span>
                <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-2">
                  {c.declarations.map((d) => `${d.number}. ${d.text}`).join(" ")}
                </p>
                <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300">
                  <ChevronDown size={10} />
                  {t("metadata.caseLawExpandDecision")}
                </span>
              </button>
            ) : (
              <div>
                <ol className="space-y-1.5 text-[11px] text-gray-600 dark:text-gray-400 leading-relaxed list-none">
                  {c.declarations.map((d) => (
                    <li key={d.number}>
                      <span className="font-semibold text-gray-700 dark:text-gray-300">{d.number}.</span>{" "}
                      {d.text}
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300"
                >
                  <ChevronUp size={10} />
                  {t("metadata.caseLawCollapse")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Footer: ECLI + EUR-Lex link */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-gray-100 pt-2 dark:border-gray-700/50">
          {c.ecli && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
              {c.ecli}
            </span>
          )}
          <a
            href={eurlexUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md bg-teal-50 px-2.5 py-1 text-[11px] font-medium text-teal-700 hover:bg-teal-100 transition-colors dark:bg-teal-900/30 dark:text-teal-300 dark:hover:bg-teal-900/50"
          >
            {t("metadata.caseLawReadFullJudgment")}
            <ExternalLink size={10} />
          </a>
        </div>
      </div>
    </li>
  );
}

export function CaseLawModal({ isOpen, onClose, cases, currentLang, celex }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset on open/close
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setVisibleCount(PAGE_SIZE);
    }
  }, [isOpen]);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  // Lock body scroll when open
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!cases) return [];
    if (!query.trim()) return cases;
    const q = query.toLowerCase();
    return cases.filter((c) => {
      if (c.name?.toLowerCase().includes(q)) return true;
      if (c.caseNumber?.toLowerCase().includes(q)) return true;
      if (c.celex?.toLowerCase().includes(q)) return true;
      if (c.ecli?.toLowerCase().includes(q)) return true;
      if (c.articlesCited?.some((a) => a.toLowerCase().includes(q))) return true;
      if (c.declarations?.some((d) => d.text.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [cases, query]);

  // Reset pagination when search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query]);

  if (!isOpen) return null;

  const remaining = filtered.length - visibleCount;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Modal panel */}
      <div className="relative flex w-full max-w-2xl max-h-[85vh] flex-col rounded-2xl bg-white shadow-2xl animate-in zoom-in-95 duration-200 dark:bg-gray-900 dark:border dark:border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("metadata.caseLaw")} ({cases?.length || 0})
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("metadata.caseLawSearchPlaceholder")}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-500 dark:focus:ring-blue-500"
              autoFocus
            />
          </div>
        </div>

        {/* Case list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {celex && !query.trim() ? (
            <CaseLawDigest celex={celex} currentLang={currentLang} />
          ) : null}
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
              {t("metadata.caseLawNoResults")}
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.slice(0, visibleCount).map((c) => (
                <CaseCard key={c.celex} c={c} currentLang={currentLang} />
              ))}
            </ul>
          )}

          {/* Show more */}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
              className="mt-3 w-full rounded-lg border border-gray-200 bg-gray-50 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {t("metadata.caseLawShowMore", { count: Math.min(PAGE_SIZE, remaining), remaining })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
