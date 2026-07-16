import { Equal, GitCompareArrows, Landmark, Link2 } from "lucide-react";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function HighlightedDefinitionText({ text, query, className = "" }) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!source || needle.length < 2) return <span className={className}>{source}</span>;

  const matcher = new RegExp(`(${escapeRegExp(needle)})`, "ig");
  const parts = source.split(matcher);
  const normalizedNeedle = needle.toLocaleLowerCase();
  return (
    <span className={className}>
      {parts.map((part, index) => (
        part.toLocaleLowerCase() === normalizedNeedle ? (
          <mark
            // The index is stable because this is a deterministic split of one string.
            key={`${part}-${index}`}
            className="rounded-sm bg-amber-100 px-0.5 text-inherit dark:bg-amber-800/60"
          >
            {part}
          </mark>
        ) : part
      ))}
    </span>
  );
}

export function DefinitionSearchResult({ item, query, t }) {
  const lawCount = Number(item.lawCount) || 0;
  const hasProvenanceCounts = item.substantiveLawCount != null && item.importCount != null;
  const substantiveLawCount = hasProvenanceCounts ? Number(item.substantiveLawCount) || 0 : lawCount;
  const importCount = hasProvenanceCounts ? Number(item.importCount) || 0 : 0;
  const wordingCount = Number(item.wordingCount) || 0;
  const source = item.representativeSource || {};
  const sourceArticle = source.article ?? source.sourceArticle;
  const sourceParts = [
    source.celex,
    sourceArticle ? t("search.definitionSourceArticle", { article: sourceArticle }) : null,
    source.title || source.law?.title,
  ].filter(Boolean);
  // Only the provenance-aware response guarantees that wordingCount excludes
  // definitions merely imported by reference. Older servers retain a useful
  // law count but do not get a potentially misleading equivalence cue.
  const sharedIdentically = hasProvenanceCounts && substantiveLawCount > 1 && wordingCount === 1;
  const differsAcrossLaws = hasProvenanceCounts && wordingCount > 1;

  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-2.5">
        <span className="flex-shrink-0 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
          {t("search.segDefinitions")}
        </span>
        <HighlightedDefinitionText
          text={item.term}
          query={query}
          className="min-w-0 flex-1 truncate font-display text-base font-bold text-eu-navy group-hover:text-eu-blue dark:text-white dark:group-hover:text-eu-blue-bright"
        />
      </div>
      {item.sampleDefinition ? (
        <HighlightedDefinitionText
          text={item.sampleDefinition}
          query={query}
          className="line-clamp-2 text-sm leading-relaxed text-gray-500 dark:text-gray-300"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[10.5px] font-medium">
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {t("search.definitionLawCount", {
            count: substantiveLawCount,
            lawWord: substantiveLawCount === 1 ? t("search.law") : t("search.laws"),
          })}
        </span>
        {sharedIdentically ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <Equal size={11} aria-hidden="true" />
            {t("search.definitionSameWording")}
          </span>
        ) : differsAcrossLaws ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
            <GitCompareArrows size={11} aria-hidden="true" />
            {t("search.definitionDifferentWordings")}
          </span>
        ) : null}
        {importCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
            <Link2 size={11} aria-hidden="true" />
            {t("search.definitionImportCount", { count: importCount })}
          </span>
        ) : null}
      </div>
      {sourceParts.length > 0 ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
          <Landmark size={11} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {t("search.definitionRepresentativeSource")}: {sourceParts.join(" · ")}
          </span>
        </p>
      ) : null}
    </>
  );
}
