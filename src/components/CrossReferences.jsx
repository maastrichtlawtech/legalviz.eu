import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { buildEurlexOjUrl, buildEurlexSearchUrl } from "../utils/url.js";
import { useI18n } from "../i18n/useI18n.js";

/**
 * Displays cross-references for the currently selected article.
 *
 * Shows which other articles are referenced by the current article,
 * and which articles reference the current article (back-references).
 *
 * `compact` renders for the narrow context rail: no outer gutters, no
 * collapsible header (the rail tab already labels and counts the section),
 * content always expanded.
 */
export function CrossReferences({
  articleNumber,
  entryKey,
  crossReferences,
  articles,
  onSelectArticle,
  itemLabel = "article",
  showBackReferences = true,
  currentLang = "EN",
  onOpenExternalReference,
  isExternalReferencePending,
  compact = false,
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const showContent = compact || isOpen;
  const referenceKey = entryKey || articleNumber;
  if (!crossReferences || !referenceKey) return null;

  const allRefsForArticle = crossReferences[referenceKey] || [];

  // Forward refs: articles referenced BY this article
  const forwardRefs = allRefsForArticle.filter(r => r.type === "article");

  // External refs: other laws referenced by this article (OJ structural refs + text-pattern refs)
  const externalRefs = allRefsForArticle.filter(r => r.type === "external" || r.type === "oj_ref");

  // Back refs: articles that reference THIS article
  const backRefs = [];
  if (showBackReferences && articleNumber) {
    for (const [sourceArt, refs] of Object.entries(crossReferences)) {
      // Only article-level entries (not recital_*/annex_*)
      if (sourceArt.startsWith("recital_") || sourceArt.startsWith("annex_")) continue;
      if (sourceArt === articleNumber) continue;
      if (refs.some(r => r.type === "article" && r.target === articleNumber)) {
        backRefs.push(sourceArt);
      }
    }
  }

  if (forwardRefs.length === 0 && backRefs.length === 0 && externalRefs.length === 0) return null;

  // Build a lookup for article titles
  const titleMap = new Map();
  if (articles) {
    for (const a of articles) {
      titleMap.set(a.article_number, a.article_title || "");
    }
  }

  return (
    <div className={compact ? "" : "mt-8 px-6 md:px-12"}>
      {compact ? null : (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 border-y border-gray-200 py-3 text-left transition hover:border-amber-200 dark:border-gray-800 dark:hover:border-amber-900/70"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{t("crossReferences.title")}</span>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              {forwardRefs.length + backRefs.length + externalRefs.length}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={`shrink-0 text-sm text-gray-500 transition-transform dark:text-gray-400 ${isOpen ? "rotate-90" : ""}`}
          >
            &gt;
          </span>
        </button>
      )}
      {showContent ? (
        <div className={`space-y-4 py-3 ${compact ? "" : "border-b border-gray-200 dark:border-gray-800"}`}>
          {forwardRefs.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                {t("crossReferences.references", { itemLabel })}
              </p>
              <div className="flex flex-wrap gap-2">
                {forwardRefs.map((ref, i) => {
                  const title = titleMap.get(ref.target);
                  return (
                    <button
                      key={`fwd-${i}`}
                      className="group inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm transition hover:border-amber-300 hover:shadow-sm cursor-pointer dark:bg-gray-800 dark:border-gray-700 dark:hover:border-amber-500"
                      onClick={() => onSelectArticle(ref.target)}
                      title={title ? `Article ${ref.target} — ${title}` : `Article ${ref.target}`}
                    >
                      <span className="font-semibold text-gray-900 dark:text-gray-100">
                        Art. {ref.target}
                      </span>
                      {ref.paragraph && (
                        <span className="text-gray-500 dark:text-gray-400">
                          ({ref.paragraph})
                        </span>
                      )}
                      {title && (
                        <span className="text-xs text-gray-400 max-w-[120px] truncate dark:text-gray-500">
                          {title}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {backRefs.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                {t("crossReferences.referencedBy")}
              </p>
              <div className="flex flex-wrap gap-2">
                {backRefs.map((artNum) => {
                  const title = titleMap.get(artNum);
                  return (
                    <button
                      key={`back-${artNum}`}
                      className="group inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm transition hover:border-amber-300 hover:shadow-sm cursor-pointer dark:bg-gray-800 dark:border-gray-700 dark:hover:border-amber-500"
                      onClick={() => onSelectArticle(artNum)}
                      title={title ? `Article ${artNum} — ${title}` : `Article ${artNum}`}
                    >
                      <span className="font-semibold text-gray-900 dark:text-gray-100">
                        Art. {artNum}
                      </span>
                      {title && (
                        <span className="text-xs text-gray-400 max-w-[120px] truncate dark:text-gray-500">
                          {title}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {externalRefs.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                {t("crossReferences.external")}
              </p>
              <div className="flex flex-wrap gap-2">
                {externalRefs.map((ref, i) => {
                  const pending = typeof isExternalReferencePending === "function"
                    ? isExternalReferencePending(ref)
                    : false;
                  const href = ref.type === "oj_ref"
                    ? buildEurlexOjUrl({
                      ojColl: ref.ojColl,
                      ojYear: ref.ojYear,
                      ojNo: ref.ojNo,
                      langCode: currentLang,
                    })
                    : buildEurlexSearchUrl(ref.raw, currentLang);
                  const label = ref.type === "oj_ref"
                    ? ref.raw
                    : ref.raw.length > 60 ? ref.raw.slice(0, 57) + "…" : ref.raw;
                  const inner = (
                    <span className="font-medium text-gray-900 dark:text-gray-100 text-xs">
                      {label}
                    </span>
                  );
                  const cls = `group inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm transition dark:bg-blue-900/20 dark:border-blue-800 ${
                    pending
                      ? "cursor-progress border-blue-400 shadow-sm dark:border-blue-500"
                      : "hover:border-blue-400 hover:shadow-sm dark:hover:border-blue-500"
                  }`;
                  return (
                    <button
                      key={`ext-${i}`}
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (onOpenExternalReference) {
                          onOpenExternalReference(ref);
                        } else if (href) {
                          window.open(href, "_blank", "noopener,noreferrer");
                        }
                      }}
                      className={cls}
                      title={ref.raw}
                    >
                      {pending ? <Loader2 size={14} className="animate-spin text-blue-700 dark:text-blue-300" /> : null}
                      {inner}
                      {pending ? (
                        <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                          {t("crossReferences.resolving")}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
