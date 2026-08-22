import { useMemo } from "react";
import { DefinitionSearchResult } from "../DefinitionSearchResult.jsx";
import { FulltextSearchResult } from "../FulltextSearchResult.jsx";
import { LawResultRow } from "./LawResultRow.jsx";
import { MatchResultRow } from "./MatchResultRow.jsx";

// Split laws-mode results into a "Best match" group (the synthetic direct-open
// CELEX result, when present, plus the top backend hit) and an "All results"
// group for the remainder. The concatenated render order is identical to
// `results`, so keyboard selectedIndex still maps 1:1.
function buildResultGroups(results, isLawMode, t) {
  if (!isLawMode || results.length === 0) {
    return [{ label: null, items: results }];
  }
  const directResults = results.filter((r) => r.directCelex);
  const nonDirect = results.filter((r) => !r.directCelex);
  const bestItems = [...directResults, ...nonDirect.slice(0, 1)];
  const restItems = nonDirect.slice(1);
  const groups = [{ label: t("search.groupBestMatch"), items: bestItems }];
  if (restItems.length > 0) {
    groups.push({ label: t("search.groupAllResults"), items: restItems });
  }
  return groups;
}

export function SearchResults({
  results,
  searchMode,
  selectedIndex,
  query,
  t,
  onSelect,
  resultsRef,
}) {
  const isLawMode = searchMode === "laws";
  const resultGroups = useMemo(
    () => buildResultGroups(results, isLawMode, t),
    [isLawMode, results, t]
  );

  return (
    <div className="flex flex-col p-2 w-full" ref={resultsRef}>
      {(() => {
        let flatIndex = -1;
        return resultGroups.map((group, gi) => (
          <div key={group.label || `group-${gi}`} className="flex flex-col">
            {group.label ? (
              <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {group.label}
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              {group.items.map((item) => {
                flatIndex += 1;
                const idx = flatIndex;
                const isSelected = idx === selectedIndex;
                const dense = gi > 0;
                return (
                  <button
                    type="button"
                    key={`${item.search_kind || item.type}-${item.id}-${idx}`}
                    data-result-index={idx}
                    onClick={() => onSelect(item)}
                    className={`group flex w-full flex-col gap-1 rounded-xl px-3 text-left transition-colors ${dense ? "py-2" : "py-2.5"} ${
                      isSelected
                        ? "bg-eu-blue-soft dark:bg-eu-blue-soft-dark"
                        : "hover:bg-eu-blue-soft/60 dark:hover:bg-eu-blue-soft-dark/60"
                    }`}
                  >
                    {item.search_kind === "definition" ? (
                      <DefinitionSearchResult item={item} query={query} t={t} />
                    ) : item.search_kind === "fulltext" ? (
                      <FulltextSearchResult item={item} t={t} />
                    ) : item.search_kind === "law" ? (
                      <LawResultRow item={item} t={t} dense={dense} />
                    ) : (
                      <MatchResultRow item={item} t={t} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ));
      })()}
    </div>
  );
}