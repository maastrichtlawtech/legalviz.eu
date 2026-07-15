import { useState } from "react";
import { GeneralRecitals, RelatedRecitals } from "../RelatedRecitals.jsx";
import { RelatedCaseLaw } from "../RelatedCaseLaw.jsx";
import { CrossReferences } from "../CrossReferences.jsx";

// Count the references badge shows for an article: forward + external + back.
function countReferences(crossReferences, articleNumber) {
  if (!crossReferences || !articleNumber) return 0;
  const own = crossReferences[articleNumber] || [];
  let count = own.filter((r) => r.type === "article" || r.type === "external" || r.type === "oj_ref").length;
  for (const [source, refs] of Object.entries(crossReferences)) {
    if (source.startsWith("recital_") || source.startsWith("annex_") || source === articleNumber) continue;
    if ((refs || []).some((r) => r.type === "article" && r.target === articleNumber)) count += 1;
  }
  return count;
}

// The children render with generous below-article spacing; strip the outer
// margin/padding so they sit flush inside the narrow rail card.
const BARE = "[&>div]:!mt-0 [&>div]:!px-0";

export function LawViewerContextRail({
  relatedRecitals,
  orphanRecitalNumbers,
  allRecitals,
  recitalTitlesLoading,
  onSelectRecital,
  celex,
  articleNumber,
  currentLang,
  crossReferences,
  articles,
  onSelectArticle,
  onOpenExternalReference,
  isExternalReferencePending,
  t,
}) {
  const [tab, setTab] = useState("recitals");
  const recitalsCount = relatedRecitals?.length || 0;
  const refsCount = countReferences(crossReferences, articleNumber);

  const tabs = [
    { id: "recitals", label: t("lawViewer.tabRecitals"), count: recitalsCount },
    { id: "cases", label: t("lawViewer.tabCaseLaw"), count: null },
    { id: "references", label: t("lawViewer.tabReferences"), count: refsCount },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex border-b border-gray-200 dark:border-gray-800" role="tablist">
        {tabs.map((entry) => {
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(entry.id)}
              className={`flex-1 border-b-2 px-2 py-2.5 text-center text-xs font-medium transition-colors ${
                active
                  ? "border-eu-blue text-eu-blue dark:border-eu-blue-bright dark:text-eu-blue-bright"
                  : "border-transparent text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
              }`}
            >
              {entry.label}
              {entry.count ? <span className="ml-1 text-gray-400 dark:text-gray-500">· {entry.count}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="max-h-[calc(100vh-9rem)] overflow-y-auto px-4 py-2">
        {tab === "recitals" ? (
          recitalsCount > 0 || (orphanRecitalNumbers?.length || 0) > 0 ? (
            <div className={BARE}>
              <RelatedRecitals
                recitals={relatedRecitals}
                allRecitals={allRecitals}
                recitalTitlesLoading={recitalTitlesLoading}
                onSelectRecital={onSelectRecital}
              />
              <GeneralRecitals
                recitalNumbers={orphanRecitalNumbers}
                allRecitals={allRecitals}
                recitalTitlesLoading={recitalTitlesLoading}
                onSelectRecital={onSelectRecital}
              />
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-gray-400 dark:text-gray-500">{t("lawViewer.tabEmptyRecitals")}</p>
          )
        ) : null}

        {tab === "cases" ? (
          <div className={BARE}>
            <RelatedCaseLaw celex={celex} articleNumber={articleNumber} currentLang={currentLang} />
          </div>
        ) : null}

        {tab === "references" ? (
          refsCount > 0 ? (
            <div className={BARE}>
              <CrossReferences
                articleNumber={articleNumber}
                crossReferences={crossReferences}
                articles={articles}
                onSelectArticle={onSelectArticle}
                currentLang={currentLang}
                onOpenExternalReference={onOpenExternalReference}
                isExternalReferencePending={isExternalReferencePending}
              />
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-gray-400 dark:text-gray-500">{t("lawViewer.tabEmptyReferences")}</p>
          )
        ) : null}
      </div>
    </div>
  );
}
