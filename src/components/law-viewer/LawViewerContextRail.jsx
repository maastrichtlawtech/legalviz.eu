import { useMemo, useState } from "react";
import { RelatedCaseLaw } from "../RelatedCaseLaw.jsx";
import { CrossReferences } from "../CrossReferences.jsx";
import { CitedByPanel } from "../CitedByPanel.jsx";
import { DefinitionComparisonPanel } from "./DefinitionComparisonPanel.jsx";

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

// Everything before the recital's own words: "(39)" numbering and whitespace.
function recitalSnippet(recital) {
  return String(recital?.recital_text || "")
    .replace(/^\s*\(\d+\)\s*/, "")
    .trim();
}

// One card per related recital: number, the AI title when available, and a
// clamped two-line excerpt — enough to decide whether to jump, never the
// full recital.
function RailRecitalCards({ recitals, allRecitals, onSelectRecital, t }) {
  const lookup = useMemo(() => {
    const map = new Map();
    for (const recital of allRecitals || []) map.set(recital.recital_number, recital);
    return map;
  }, [allRecitals]);

  return (
    <div className="space-y-2 py-2">
      {recitals.map((entry) => {
        const recital = lookup.get(entry.recital_number) || entry;
        const title = String(recital.recital_title || "").trim();
        const snippet = recitalSnippet(recital);
        return (
          <button
            key={recital.recital_number}
            type="button"
            onClick={() => onSelectRecital(recital)}
            className="block w-full rounded-xl border border-gray-100 bg-gray-50 p-3 text-left transition hover:border-eu-blue/30 hover:bg-eu-blue-soft/40 dark:border-gray-800 dark:bg-gray-800/50 dark:hover:border-eu-blue/40 dark:hover:bg-eu-blue-soft-dark/40"
          >
            <div className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">
              {t("common.recital")} {recital.recital_number}
              {title ? (
                <span className="font-medium text-eu-gold-deep dark:text-eu-gold-bright"> · {title}</span>
              ) : null}
            </div>
            {snippet ? (
              <p className="mt-1 line-clamp-2 font-serif text-xs leading-5 text-gray-500 dark:text-gray-400">
                {snippet}
              </p>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// Collapsed-by-default list of the law's general (unmatched) recitals, in the
// same card style as the related-recital matches above it. The full-width
// GeneralRecitals component renders an inline comma-separated paragraph that
// falls apart in this narrow column.
function RailGeneralRecitals({ recitalNumbers, allRecitals, onSelectRecital, t }) {
  const [isOpen, setIsOpen] = useState(false);
  const recitals = useMemo(
    () => (recitalNumbers || []).map((recitalNumber) => ({ recital_number: recitalNumber })),
    [recitalNumbers]
  );

  if (recitals.length === 0) return null;

  return (
    <div className="border-t border-gray-100 pt-1 dark:border-gray-800">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left text-xs font-semibold text-gray-700 transition hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
      >
        <span>
          {t("relatedRecitals.generalTitle")}
          <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">· {recitals.length}</span>
        </span>
        <span
          aria-hidden="true"
          className={`text-gray-400 transition-transform dark:text-gray-500 ${isOpen ? "rotate-90" : ""}`}
        >
          &gt;
        </span>
      </button>
      {isOpen ? (
        <RailRecitalCards
          recitals={recitals}
          allRecitals={allRecitals}
          onSelectRecital={onSelectRecital}
          t={t}
        />
      ) : null}
    </div>
  );
}

export function LawViewerContextRail({
  relatedRecitals,
  orphanRecitalNumbers,
  allRecitals,
  onSelectRecital,
  celex,
  articleNumber,
  currentLang,
  crossReferences,
  articles,
  onSelectArticle,
  onOpenExternalReference,
  isExternalReferencePending,
  onOpenLaw,
  definitionComparison,
  t,
}) {
  const [tab, setTab] = useState("recitals");
  const recitalsCount = relatedRecitals?.length || 0;
  const refsCount = countReferences(crossReferences, articleNumber);

  const tabs = [
    { id: "recitals", label: t("lawViewer.tabRecitals"), count: recitalsCount },
    { id: "cases", label: t("lawViewer.tabCaseLaw"), count: null },
    { id: "references", label: t("lawViewer.tabReferences"), count: refsCount },
    { id: "citedBy", label: t("lawViewer.tabCitedBy"), count: null },
  ];

  if (definitionComparison?.term) {
    return (
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <DefinitionComparisonPanel
          {...definitionComparison}
          currentCelex={celex}
          t={t}
        />
      </div>
    );
  }

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
            <div>
              {recitalsCount > 0 ? (
                <>
                  <RailRecitalCards
                    recitals={relatedRecitals}
                    allRecitals={allRecitals}
                    onSelectRecital={onSelectRecital}
                    t={t}
                  />
                  <p className="px-1 pb-2 text-[10.5px] text-gray-400 dark:text-gray-500">
                    {t("lawViewer.railRecitalsHint")}
                  </p>
                </>
              ) : null}
              <RailGeneralRecitals
                recitalNumbers={orphanRecitalNumbers}
                allRecitals={allRecitals}
                onSelectRecital={onSelectRecital}
                t={t}
              />
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-gray-400 dark:text-gray-500">{t("lawViewer.tabEmptyRecitals")}</p>
          )
        ) : null}

        {tab === "cases" ? (
          <RelatedCaseLaw celex={celex} articleNumber={articleNumber} currentLang={currentLang} compact />
        ) : null}

        {tab === "references" ? (
          refsCount > 0 ? (
            <CrossReferences
              articleNumber={articleNumber}
              crossReferences={crossReferences}
              articles={articles}
              onSelectArticle={onSelectArticle}
              currentLang={currentLang}
              onOpenExternalReference={onOpenExternalReference}
              isExternalReferencePending={isExternalReferencePending}
              compact
            />
          ) : (
            <p className="py-6 text-center text-xs text-gray-400 dark:text-gray-500">{t("lawViewer.tabEmptyReferences")}</p>
          )
        ) : null}

        {tab === "citedBy" ? (
          <CitedByPanel
            celex={celex}
            articleNumber={articleNumber}
            currentLang={currentLang}
            onOpenLaw={onOpenLaw}
            compact
          />
        ) : null}
      </div>
    </div>
  );
}
