import { inferOfficialReferenceFromCelex } from "./library.js";

export function formatOfficialReference(reference) {
  if (!reference?.actType || !reference?.year || !reference?.number) return null;
  const actTypeLabel = reference.actType.charAt(0).toUpperCase() + reference.actType.slice(1);
  return `${actTypeLabel} (EU) ${reference.year}/${reference.number}`;
}

export function cleanLawTitle(title, referenceLabel) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw || !referenceLabel) return raw;
  const escapedReference = referenceLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(new RegExp(`^${escapedReference}\\s+`, "i"), "").trim() || raw;
}

// Official EU titles bury the memorable name in parentheses ("… (General Data
// Protection Regulation)"); pull out the first parenthetical that isn't the
// EEA-relevance boilerplate.
export function extractShortLawTitle(title) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const matches = Array.from(raw.matchAll(/\(([^)]{5,120})\)/g));
  for (const match of matches) {
    const candidate = String(match[1] || "").trim();
    if (!candidate) continue;
    if (/text with eea relevance/i.test(candidate)) continue;
    return candidate;
  }

  return "";
}

// Compact one-line label for a law where the full official title would be
// overwhelming (e.g. list rows, the context rail). Returns the short name
// with the official reference when both exist, and the full title separately
// for use as a tooltip.
export function buildLawDisplayLabel({ celex, title } = {}) {
  const referenceLabel = formatOfficialReference(inferOfficialReferenceFromCelex(celex));
  const shortTitle = extractShortLawTitle(title);
  const label = shortTitle && referenceLabel
    ? `${shortTitle} — ${referenceLabel}`
    : shortTitle
      || referenceLabel
      || String(title || "").replace(/\s+/g, " ").trim()
      || String(celex || "");
  const fullTitle = String(title || "").replace(/\s+/g, " ").trim();
  return { label, fullTitle: fullTitle && fullTitle !== label ? fullTitle : "" };
}
