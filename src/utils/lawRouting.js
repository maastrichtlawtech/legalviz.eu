import { normalizeUiLocale } from "../i18n/localeMeta.js";

const VALID_ACT_TYPES = new Set(["regulation", "directive", "decision"]);
const FEATURED_LAWS = [
  {
    slug: "gdpr",
    celex: "32016R0679",
    label: "GDPR",
    officialReference: { actType: "regulation", year: "2016", number: "679" },
  },
  {
    slug: "dma",
    celex: "32022R1925",
    label: "Digital Markets Act",
    officialReference: { actType: "regulation", year: "2022", number: "1925" },
  },
  {
    slug: "dsa",
    celex: "32022R2065",
    label: "Digital Services Act",
    officialReference: { actType: "regulation", year: "2022", number: "2065" },
  },
  {
    slug: "aia",
    celex: "32024R1689",
    label: "AI Act",
    officialReference: { actType: "regulation", year: "2024", number: "1689" },
  },
  {
    slug: "data-act",
    celex: "32023R2854",
    label: "Data Act",
    officialReference: { actType: "regulation", year: "2023", number: "2854" },
  },
  {
    slug: "dga",
    celex: "32022R0868",
    label: "Data Governance Act",
    officialReference: { actType: "regulation", year: "2022", number: "868" },
  },
  {
    slug: "p2b",
    celex: "32019R1150",
    label: "Platform-to-Business Regulation",
    officialReference: { actType: "regulation", year: "2019", number: "1150" },
  },
  {
    slug: "nis-2",
    celex: "32022L2555",
    label: "NIS 2 Directive",
    officialReference: { actType: "directive", year: "2022", number: "2555" },
  },
];

function slugifySegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOfficialReference(reference) {
  if (!reference) return null;
  const actType = String(reference.actType || "").trim().toLowerCase();
  const year = String(reference.year || "").trim();
  const number = String(reference.number || "").trim();

  if (!VALID_ACT_TYPES.has(actType) || !/^\d{4}$/.test(year) || !/^\d{1,4}$/.test(number)) {
    return null;
  }

  return { actType, year, number };
}

function buildOfficialReferenceSlug(reference) {
  const normalized = normalizeOfficialReference(reference);
  if (!normalized) return null;
  return `${normalized.actType}-${normalized.year}-${normalized.number}`;
}

export function getLawSlug(law) {
  const explicitSlug = slugifySegment(law?.slug);
  if (explicitSlug) return explicitSlug;

  const shortname = slugifySegment(law?.shortname);
  if (shortname) return shortname;

  return buildOfficialReferenceSlug(law?.officialReference);
}

export function enrichLaw(law) {
  const officialReference = normalizeOfficialReference(law?.officialReference);
  const slug = getLawSlug({ ...law, officialReference });

  return {
    ...law,
    key: law?.key || slug || null,
    officialReference,
    shownInUi: law?.shownInUi !== false,
    slug,
  };
}

export function getBundledLaws() {
  return FEATURED_LAWS.map((law) => enrichLaw(law));
}

export function findBundledLawByKey(key) {
  return findBundledLawBySlug(key);
}

export function findBundledLawByCelex(celex) {
  const normalized = String(celex || "").trim().toUpperCase();
  if (!normalized) return null;
  return getBundledLaws().find((law) => law.celex === normalized) || null;
}

export function findBundledLawBySlug(slug) {
  const normalized = slugifySegment(slug);
  if (!normalized) return null;
  return getBundledLaws().find((law) => law.slug === normalized) || null;
}

export function getCanonicalLawRoute(law, kind = null, id = null, locale = "en") {
  const slug = getLawSlug(law);
  if (!slug) {
    // Laws without an official-reference slug (e.g. Commission proposals, COM
    // documents) are opened through the celex-based import route.
    const celex = String(law?.celex || "").trim().toUpperCase();
    if (!celex) return "/";
    const query = `?celex=${encodeURIComponent(celex)}`;
    // "overview" is the bare-slug landing state, not a real entry to link to.
    if (kind === "overview") return `/import${query}`;
    if (kind && id != null) return `/import/${kind}/${encodeURIComponent(String(id))}${query}`;
    return `/import${query}`;
  }
  const base = normalizeUiLocale(locale) === "en" ? `/${slug}` : `/${normalizeUiLocale(locale)}/${slug}`;
  if (kind === "overview") return base;
  if (kind && id != null) return `${base}/${kind}/${encodeURIComponent(String(id))}`;
  return base;
}

export function buildImportedLawCandidate(entry = {}) {
  const bundledLaw = findBundledLawByCelex(entry.celex)
    || findBundledLawBySlug(entry.slug)
    || findBundledLawByKey(entry.key);
  const officialReference = normalizeOfficialReference(entry.officialReference);
  const merged = {
    ...bundledLaw,
    ...entry,
    officialReference: officialReference || bundledLaw?.officialReference || null,
  };
  const slug = getLawSlug(merged);

  return {
    ...merged,
    officialReference: merged.officialReference,
    slug,
  };
}

export function getActTypeChoices() {
  return Array.from(VALID_ACT_TYPES);
}

export function parseOfficialReferenceSlug(slug) {
  const match = String(slug || "").match(/^(regulation|directive|decision)-(\d{4})-(\d{1,4})$/);
  if (!match) return null;

  return {
    actType: match[1],
    year: match[2],
    number: match[3],
  };
}
