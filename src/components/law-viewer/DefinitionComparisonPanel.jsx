import { ArrowUpRight, Link2, Loader2, RefreshCw, X } from "lucide-react";

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

function sourceKey(occurrence) {
  const article = occurrence?.sourceArticle ?? occurrence?.article ?? "";
  const point = occurrence?.sourcePoint ?? occurrence?.point ?? "";
  return `${String(occurrence?.celex || "").toUpperCase()}:${String(article)}${point ? `:${String(point)}` : ""}`;
}

function isImported(occurrence) {
  return occurrence?.classification === "imported";
}

function isSubstantive(occurrence) {
  const classification = occurrence?.classification || "substantive";
  return classification === "substantive" || classification === "hybrid";
}

function groupSubstantiveOccurrences(comparison, currentCelex, selectedSource) {
  const byHash = new Map();
  for (const occurrence of getOccurrences(comparison).filter(isSubstantive)) {
    const hash = occurrence.definitionHash || occurrence.normalizedDefinition || occurrence.definition;
    if (!hash) continue;
    const group = byHash.get(hash) || [];
    group.push(occurrence);
    byHash.set(hash, group);
  }

  const priority = (entry) => {
    if (selectedSource && sourceKey(entry) === selectedSource) return 2;
    return String(entry.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase() ? 1 : 0;
  };

  return [...byHash.entries()]
    .map(([hash, occurrences]) => ({
      hash,
      occurrences: [...occurrences].sort((left, right) => priority(right) - priority(left)),
    }))
    .sort((left, right) => Math.max(...right.occurrences.map(priority)) - Math.max(...left.occurrences.map(priority)));
}

function getImportTarget(occurrence, t) {
  const edge = occurrence?.referenceEdges?.find((entry) => entry?.targetCelex) || occurrence?.referenceEdges?.[0];
  if (!edge) return "";
  return [
    edge.targetCelex,
    edge.targetArticle ? t("definitionComparison.article", { article: edge.targetArticle }) : null,
    edge.targetPoint ? t("definitionComparison.point", { point: edge.targetPoint }) : null,
  ].filter(Boolean).join(" · ");
}

function DefinitionOccurrence({ occurrence, currentCelex, selectedSource, label, imported = false, onOpenSource, t }) {
  const isCurrent = String(occurrence.celex || "").toUpperCase() === String(currentCelex || "").toUpperCase();
  const isSelected = Boolean(selectedSource) && sourceKey(occurrence) === selectedSource;
  const sourceArticle = occurrence.sourceArticle ?? occurrence.article ?? null;
  const title = occurrence.title || occurrence.lawTitle || occurrence.law?.title || occurrence.celex;
  const referenceTarget = (imported || occurrence.classification === "hybrid") ? getImportTarget(occurrence, t) : "";

  return (
    <div className={`border-l-2 py-3 pl-3 ${
      isSelected
        ? "border-eu-gold bg-eu-gold-soft/30 dark:border-eu-gold-bright dark:bg-eu-gold-soft-dark/20"
        : isCurrent
          ? "border-eu-blue bg-eu-blue-soft/30 dark:border-eu-blue-bright dark:bg-eu-blue-soft-dark/30"
          : "border-gray-200 dark:border-gray-700"
    }`} data-definition-source={sourceKey(occurrence)}>
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
          {isSelected ? t("definitionComparison.selectedSource") : isCurrent ? t("definitionComparison.current") : label}
        </span>
      </div>
      {referenceTarget ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
          <Link2 size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t(imported ? "definitionComparison.importsFrom" : "definitionComparison.alsoReferences", { source: referenceTarget })}
        </p>
      ) : null}
      <p className="mt-2 font-serif text-xs leading-5 text-gray-600 dark:text-gray-300">
        {occurrence.definition}
      </p>
      <button
        type="button"
        onClick={() => onOpenSource?.(occurrence.celex, sourceArticle, occurrence.sourcePoint ?? occurrence.point ?? null)}
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
  selectedSource = "",
  loading,
  error,
  onRetry,
  onClose,
  onOpenSource,
  compact = false,
  t,
}) {
  const allOccurrences = getOccurrences(comparison);
  const groups = groupSubstantiveOccurrences(comparison, currentCelex, selectedSource);
  const imports = allOccurrences.filter(isImported);
  const unclassified = allOccurrences.filter((entry) => !isSubstantive(entry) && !isImported(entry));
  const substantiveOccurrences = groups.reduce((count, group) => count + group.occurrences.length, 0);
  const occurrences = substantiveOccurrences + imports.length + unclassified.length;
  const lawCount = comparison?.substantiveLawCount
    ?? new Set(groups.flatMap((group) => group.occurrences).map((entry) => entry.celex).filter(Boolean)).size;
  const wordingCount = comparison?.wordingCount ?? groups.length;
  const importCount = comparison?.importCount ?? imports.length;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 pb-3 dark:border-gray-800">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-bold text-eu-navy dark:text-white">
            {comparison?.displayTerm || comparison?.term || term}
          </h3>
          {!loading && !error ? (
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
              {t("definitionComparison.provenanceSummary", {
                laws: lawCount,
                wordings: wordingCount,
                imports: importCount,
                lawWord: lawCount === 1 ? t("search.law") : t("search.laws"),
                wordingWord: wordingCount === 1 ? t("search.wording") : t("search.wordings"),
                importWord: importCount === 1 ? t("definitionComparison.import") : t("definitionComparison.imports"),
              })}
            </p>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200">
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
          <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            <RefreshCw size={13} />
            {t("common.retry")}
          </button>
        </div>
      ) : occurrences === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400 dark:text-gray-500">{t("definitionComparison.empty")}</p>
      ) : (
        <div className={compact ? "max-h-[55vh] overflow-y-auto pt-1" : "pt-1"}>
          {substantiveOccurrences > 0 ? (
            <section aria-labelledby="definition-comparison-substantive">
              <h4 id="definition-comparison-substantive" className="px-1 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {t("definitionComparison.definitionsInActs")}
              </h4>
              {groups.map((group, groupIndex) => group.occurrences.map((occurrence) => (
                <DefinitionOccurrence
                  key={occurrence.occurrenceId || `${group.hash}-${occurrence.celex}-${occurrence.sourceArticle || occurrence.article || ""}`}
                  occurrence={occurrence}
                  currentCelex={currentCelex}
                  selectedSource={selectedSource}
                  label={groupIndex === 0 ? t("definitionComparison.sameDefinition") : t("definitionComparison.differentDefinition")}
                  onOpenSource={onOpenSource}
                  t={t}
                />
              )))}
            </section>
          ) : null}
          {imports.length > 0 ? (
            <section aria-labelledby="definition-comparison-imports">
              <h4 id="definition-comparison-imports" className="border-t border-gray-100 px-1 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:border-gray-800 dark:text-gray-500">
                {t("definitionComparison.importedByReference")}
              </h4>
              {imports.map((occurrence) => (
                <DefinitionOccurrence
                  key={occurrence.occurrenceId || `import-${occurrence.celex}-${occurrence.sourceArticle || occurrence.article || ""}`}
                  occurrence={occurrence}
                  currentCelex={currentCelex}
                  selectedSource={selectedSource}
                  label={t("definitionComparison.imported")}
                  imported
                  onOpenSource={onOpenSource}
                  t={t}
                />
              ))}
            </section>
          ) : null}
          {unclassified.length > 0 ? (
            <section aria-labelledby="definition-comparison-unclassified">
              <h4 id="definition-comparison-unclassified" className="border-t border-gray-100 px-1 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:border-gray-800 dark:text-gray-500">
                {t("definitionComparison.otherExtracted")}
              </h4>
              {unclassified.map((occurrence) => (
                <DefinitionOccurrence
                  key={occurrence.occurrenceId || `unclassified-${occurrence.celex}-${occurrence.sourceArticle || occurrence.article || ""}`}
                  occurrence={occurrence}
                  currentCelex={currentCelex}
                  selectedSource={selectedSource}
                  label={t("definitionComparison.unclassified")}
                  onOpenSource={onOpenSource}
                  t={t}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
