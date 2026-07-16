export const INITIAL_CITED_BY_PER_SECTION = 5;

export function isCitedByUnavailableError(error) {
  return Boolean(error)
    && (error.status === 404 || error.status === 503 || error.code === "citation_graph_unavailable");
}

// The backend store (publicSourceUnit in citation-graph-store.js) already strips
// these recital_/annex_ prefixes; this client-side copy is deliberate defense for
// older or raw payloads that may still carry them — do not "simplify" it away.
export function normalizeCitedByUnit(unitType, unit) {
  if (typeof unit !== "string") return unit;
  const normalizedType = String(unitType || "").trim().toLowerCase();
  if (normalizedType !== "recital" && normalizedType !== "annex") return unit;
  const prefix = `${normalizedType}_`;
  if (!unit.toLowerCase().startsWith(prefix) || unit.length === prefix.length) return unit;
  return unit.slice(prefix.length);
}

export function formatCitedByUnitLabel(unitType, unit) {
  const normalizedType = String(unitType || "").trim().toLowerCase();
  if (normalizedType === "article") return `Article ${unit}`;
  if (normalizedType === "recital") return `Recital ${unit}`;
  if (normalizedType === "annex") return `Annex ${unit}`;
  return unit == null ? "" : String(unit);
}

export function formatCitedByReference(article, reference = {}) {
  if (article == null || String(article).trim() === "") return reference.raw || "";
  const paragraph = reference.paragraph == null || String(reference.paragraph).trim() === ""
    ? ""
    : `(${String(reference.paragraph).trim()})`;
  const point = reference.point == null || String(reference.point).trim() === ""
    ? ""
    : `(${String(reference.point).trim()})`;
  return `→ Art. ${article}${paragraph}${point}`;
}

function uniqueReferenceChips(article, references, formatReference) {
  return [...new Set((Array.isArray(references) ? references : [])
    .map((reference) => formatReference(article, reference || {}))
    .filter(Boolean))];
}

export function buildCitedByDisplay(payload, {
  expanded = false,
  initialPerSection = INITIAL_CITED_BY_PER_SECTION,
  formatUnitLabel = formatCitedByUnitLabel,
  formatReference = formatCitedByReference,
} = {}) {
  const article = payload?.article == null ? "" : String(payload.article);
  const provisions = (Array.isArray(payload?.citingProvisions) ? payload.citingProvisions : []).map((source) => {
    const unitType = String(source?.unitType || "").trim().toLowerCase();
    const unit = normalizeCitedByUnit(unitType, source?.unit);
    return {
      ...source,
      unitType,
      unit,
      unitLabel: formatUnitLabel(unitType, unit),
      articleNumber: unitType === "article" ? unit : null,
      referenceChips: uniqueReferenceChips(article, source?.references, formatReference),
    };
  });
  const judgments = (Array.isArray(payload?.citingJudgments) ? payload.citingJudgments : []).map((source) => ({
    ...source,
    referenceChips: uniqueReferenceChips(article, source?.references, formatReference),
  }));
  // One entry per citing law, so the (very long) law title renders once with
  // its citing units grouped under it instead of once per unit.
  const provisionGroups = [];
  const groupsByCelex = new Map();
  for (const provision of provisions) {
    let group = groupsByCelex.get(provision.celex);
    if (!group) {
      group = { celex: provision.celex, title: provision.title || null, units: [] };
      groupsByCelex.set(provision.celex, group);
      provisionGroups.push(group);
    }
    group.units.push(provision);
  }

  const visibleLimit = Math.max(0, Number(initialPerSection) || 0);
  const visibleProvisionGroups = expanded ? provisionGroups : provisionGroups.slice(0, visibleLimit);
  const visibleProvisions = visibleProvisionGroups.flatMap((group) => group.units);
  const visibleJudgments = expanded ? judgments : judgments.slice(0, visibleLimit);
  const returnedCount = Number.isFinite(Number(payload?.pagination?.returned))
    ? Number(payload.pagination.returned)
    : provisions.length + judgments.length;
  const total = Number.isFinite(Number(payload?.counts?.total))
    ? Number(payload.counts.total)
    : returnedCount;

  return {
    provisions,
    judgments,
    provisionGroups,
    visibleProvisionGroups,
    visibleProvisions,
    visibleJudgments,
    counts: {
      provisions: Number(payload?.counts?.provisions) || provisions.length,
      judgments: Number(payload?.counts?.judgments) || judgments.length,
      total,
    },
    returnedCount,
    overflowCount: Math.max(0, total - returnedCount),
    hiddenCount: (provisions.length - visibleProvisions.length) + (judgments.length - visibleJudgments.length),
    hasHiddenResults: visibleProvisions.length < provisions.length || visibleJudgments.length < judgments.length,
    empty: total === 0,
  };
}
