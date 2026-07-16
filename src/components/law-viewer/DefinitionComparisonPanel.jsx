import { ArrowUpRight, Loader2, RefreshCw, X } from "lucide-react";

function getOccurrences(comparison) {
  if (Array.isArray(comparison?.occurrences)) return comparison.occurrences;
  if (!Array.isArray(comparison?.groups)) return [];
  return comparison.groups.flatMap((group) => (
    Array.isArray(group?.occurrences)
      ? group.occurrences.map((occurrence) => ({
        ...occurrence,
        definitionHash: occurrence.definitionHash || group.definitionHash || null,
      }))
      : []
  ));
}

function groupOccurrences(comparison, currentCelex) {
  const byHash = new Map();
  for (const occurrence of getOccurrences(comparison)) {
    const hash = occurrence.definitionHash || occurrence.normalizedDefinition || occurrence.definition;
    if (!hash) continue;
    const group = byHash.get(hash) || [];
    group.push(occurrence);
    byHash.set(hash, group);
  }

  return [...byHash.entries()]
    .map(([hash, occurrences]) => ({
      hash,
      occurrences: [...occurrences].sort((left, right) => {
        const leftCurrent = String(left.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase();
        const rightCurrent = String(right.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase();
        return Number(rightCurrent) - Number(leftCurrent);
      }),
    }))
    .sort((left, right) => {
      const leftCurrent = left.occurrences.some((entry) => String(entry.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase());
      const rightCurrent = right.occurrences.some((entry) => String(entry.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase());
      return Number(rightCurrent) - Number(leftCurrent);
    });
}

function DefinitionOccurrence({ occurrence, currentCelex, wordingLabel, onOpenSource, t }) {
  const isCurrent = String(occurrence.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase();
  const sourceArticle = occurrence.sourceArticle || occurrence.article || null;
  const title = occurrence.title || occurrence.lawTitle || occurrence.law?.title || occurrence.celex;

  return (
    <div className={`border-l-2 py-3 pl-3 ${
      isCurrent
        ? "border-eu-blue bg-eu-blue-soft/30 dark:border-eu-blue-bright dark:bg-eu-blue-soft-dark/30"
        : "border-gray-200 dark:border-gray-700"
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{title}</div>
          <div className="mt-0.5 text-[10.5px] text-gray-400 dark:text-gray-500">
            {[occurrence.celex, sourceArticle ? t("definitionComparison.article", { article: sourceArticle }) : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {isCurrent ? t("definitionComparison.current") : wordingLabel}
        </span>
      </div>
      <p className="mt-2 font-serif text-xs leading-5 text-gray-600 dark:text-gray-300">
        {occurrence.definition}
      </p>
      <button
        type="button"
        onClick={() => onOpenSource?.(occurrence.celex, sourceArticle)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-eu-blue hover:underline dark:text-eu-blue-bright"
      >
        {t("definitionComparison.openSource")}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function DefinitionComparisonPanel({
  term,
  comparison,
  currentCelex,
  loading,
  error,
  onRetry,
  onClose,
  onOpenSource,
  compact = false,
  t,
}) {
  const groups = groupOccurrences(comparison, currentCelex);
  const occurrences = groups.reduce((count, group) => count + group.occurrences.length, 0);
  const lawCount = comparison?.lawCount || new Set(getOccurrences(comparison).map((entry) => entry.celex).filter(Boolean)).size;
  const wordingCount = comparison?.wordingCount || groups.length;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 pb-3 dark:border-gray-800">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-bold text-eu-navy dark:text-white">
            {comparison?.displayTerm || comparison?.term || term}
          </h3>
          {!loading && !error ? (
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
              {t("definitionComparison.summary", {
                laws: lawCount,
                wordings: wordingCount,
                lawWord: lawCount === 1 ? t("search.law") : t("search.laws"),
                wordingWord: wordingCount === 1 ? t("search.wording") : t("search.wordings"),
              })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <X size={16} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-gray-400 dark:text-gray-500">
          <Loader2 size={15} className="animate-spin" />
          {t("definitionComparison.loading")}
        </div>
      ) : error ? (
        <div className="py-6 text-center">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <RefreshCw size={13} />
            {t("common.retry")}
          </button>
        </div>
      ) : occurrences === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400 dark:text-gray-500">
          {t("definitionComparison.empty")}
        </p>
      ) : (
        <div className={compact ? "max-h-[55vh] overflow-y-auto pt-1" : "pt-1"}>
          {groups.map((group, groupIndex) => group.occurrences.map((occurrence) => (
            <DefinitionOccurrence
              key={`${group.hash}-${occurrence.celex}-${occurrence.sourceArticle || occurrence.article || ""}`}
              occurrence={occurrence}
              currentCelex={currentCelex}
              wordingLabel={groupIndex === 0
                ? t("definitionComparison.sameWording")
                : t("definitionComparison.differentWording")}
              onOpenSource={onOpenSource}
              t={t}
            />
          )))}
        </div>
      )}
    </div>
  );
}
