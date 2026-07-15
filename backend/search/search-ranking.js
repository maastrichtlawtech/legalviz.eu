const GENERIC_OJ_TITLE = "Official Journal of the European Union";

const KNOWN_ALIASES = {
  "32000L0031": [
    "ecommerce",
    "e commerce",
    "e commerce directive",
    "ecommerce directive",
    "electronic commerce directive",
    "directive 2000/31",
  ],
  "32016L0680": [
    "law enforcement directive",
    "led",
    "police directive",
    "directive 2016/680",
  ],
  "32016R0679": ["gdpr", "general data protection regulation"],
  "32002L0058": [
    "eprivacy",
    "eprivacy directive",
    "directive on privacy and electronic communications",
    "privacy and electronic communications directive",
    "directive 2002/58",
  ],
  "32015L2366": ["payment services directive", "psd2"],
  "32018L1972": ["european electronic communications code", "eecc"],
  "32022R0868": ["data governance act"],
  "32022R1925": ["digital markets act"],
  "32022R2065": ["digital services act"],
  "32023R2854": ["data act"],
  "32024R1689": ["ai act", "artificial intelligence act"],
  "32022L2464": ["csrd"],
  "32023R1114": ["mica"],
  "32024R1083": ["emfa", "european media freedom act"],
  "32024L1799": ["right to repair"],
  "32024R2847": ["cyber resilience act", "cra"],
  "32024L2831": ["platform work directive"]
};

const QUERY_REWRITES = new Map([
  ["dma", "digital markets act"],
  ["dsa", "digital services act"],
  ["dora", "regulation 2022/2554"],
  ["nis2", "directive 2022/2555"],
  ["nis 2", "directive 2022/2555"],
  ["p2b", "regulation 2019/1150"],
  ["eidas", "regulation 2014/910"],
  ["ecommerce", "directive 2000/31"],
  ["e commerce", "directive 2000/31"],
  ["e commerce directive", "directive 2000/31"],
  ["ecommerce directive", "directive 2000/31"],
  ["eprivacy", "directive 2002/58"],
  ["law enforcement directive", "directive 2016/680"],
  ["led", "directive 2016/680"],
  ["police directive", "directive 2016/680"],
  ["digital governance act", "data governance act"],
  ["open data directive", "directive 2019/1024"],
  ["platform to business regulation", "regulation 2019/1150"],
  ["eprivacy directive", "directive 2002/58"]
]);

const LOW_SIGNAL_TERMS = new Set([
  "act",
  "eu",
  "of",
  "the",
  "and",
  "on",
  "for"
]);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function inferTypeFromCelex(celex) {
  const marker = String(celex || "")[5];
  if (marker === "R") return "regulation";
  if (marker === "L") return "directive";
  if (marker === "D") return "decision";
  return "unknown";
}

function extractYearNumberFromCelex(celex) {
  const value = String(celex || "");
  const match = value.match(/^3(\d{4})([RLD])0*(\d{1,4})/);
  if (!match) {
    return { year: null, number: null };
  }
  return {
    year: match[1],
    number: String(Number.parseInt(match[3], 10))
  };
}

function normalizeTypeToken(value) {
  const text = normalizeText(value);
  if (text.includes("regulation") || text === "reg" || text === "r") return "regulation";
  if (text.includes("directive") || text === "dir" || text === "l") return "directive";
  if (text.includes("decision") || text === "dec" || text === "d") return "decision";
  return null;
}

function isCorrigendumCelex(celex) {
  return /\(\d+\)$/.test(String(celex || ""));
}

function getEliKind(eli) {
  const value = String(eli || "").toLowerCase();
  if (/\/eli\/(reg|dir|dec)\/\d{4}\/\d+\/oj$/.test(value)) return "primary";
  if (value.includes("/reg_impl/")) return "implementing";
  if (value.includes("/reg_del/")) return "delegated";
  if (value.includes("/corrigendum/")) return "corrigendum";
  return "other";
}

function parseStructuredQuery(query, options = {}) {
  const rawQuery = String(query || "");
  const rewrittenQuery = options.disableRewrites
    ? rawQuery
    : (QUERY_REWRITES.get(normalizeText(rawQuery)) || rawQuery);
  const raw = rewrittenQuery.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const normalized = normalizeText(rewrittenQuery);
  const compact = normalized.replace(/\s+/g, "");
  const celexCompact = compact.toUpperCase().replace(/[^0-9A-Z()]/g, "");
  const celexMatch = celexCompact.match(/^3\d{4}[RLD]\d{1,4}(?:\(\d+\))?$/);

  const slashMatch = raw.match(/\b(\d{4})\s*\/\s*(\d{1,4})\b/);
  const typePrefixMatch = raw.match(/\b(regulation|directive|decision)\b/);
  const leadingTypeYearNumberMatch = raw.match(
    /\b(regulation|directive|decision)\b[^0-9]*(\d{4})\s*\/\s*(\d{1,4})\b/
  );

  return {
    originalQuery: rawQuery,
    rewrittenQuery,
    normalized,
    compact,
    terms: normalized
      .split(" ")
      .filter(Boolean)
      .filter((term) => term.length >= 2)
      .filter((term) => !LOW_SIGNAL_TERMS.has(term)),
    celex: celexMatch ? celexMatch[0] : null,
    year: leadingTypeYearNumberMatch?.[2] || slashMatch?.[1] || null,
    number: leadingTypeYearNumberMatch?.[3]
      ? String(Number.parseInt(leadingTypeYearNumberMatch[3], 10))
      : (slashMatch?.[2] ? String(Number.parseInt(slashMatch[2], 10)) : null),
    type: normalizeTypeToken(leadingTypeYearNumberMatch?.[1] || typePrefixMatch?.[1] || "")
  };
}

function buildAcronymVariants(text) {
  const raw = String(text || "");
  const normalized = normalizeText(raw);
  if (!normalized) return [];

  const rawWords = normalized.split(" ").filter(Boolean);
  const stopwords = new Set([
    "of", "the", "and", "for", "on", "with", "to", "in", "by", "as", "a", "an",
    "text", "eea", "relevance", "union", "european", "council", "parliament"
  ]);
  const words = rawWords.filter((word) => !stopwords.has(word));

  const variants = new Set();
  const acronym = words
    .filter((word) => /^[a-z0-9]+$/.test(word))
    .map((word) => (/\d/.test(word) ? word : word[0]))
    .join("");

  if (acronym.length >= 2 && acronym.length <= 8) {
    variants.add(acronym);
  }

  const phraseMatch = raw.match(/\(([^)]+)\)/);
  if (phraseMatch) {
    const phraseWords = normalizeText(phraseMatch[1]).split(" ").filter(Boolean);
    const phraseAcronym = phraseWords
      .filter((word) => !stopwords.has(word))
      .map((word) => (/\d/.test(word) ? word : word[0]))
      .join("");
    if (phraseAcronym.length >= 2 && phraseAcronym.length <= 8) {
      variants.add(phraseAcronym);
    }
  }

  return [...variants];
}

function buildAliases(record) {
  const aliases = [];
  const celex = String(record.celex || "");

  aliases.push(celex);
  aliases.push(record.type);
  aliases.push(`${record.type} ${celex}`);

  if (record.title && record.title !== GENERIC_OJ_TITLE) {
    aliases.push(...buildAcronymVariants(record.title));
  }

  if (KNOWN_ALIASES[celex]) {
    aliases.push(...KNOWN_ALIASES[celex]);
  }

  const normalizedAliases = aliases.map(normalizeText);
  const compactAliases = normalizedAliases
    .filter((alias) => alias.length >= 2)
    .map((alias) => alias.replace(/\s+/g, ""));

  return unique([...normalizedAliases, ...compactAliases]);
}

function enrichSearchRecord(record) {
  const title = record.title === GENERIC_OJ_TITLE || record.title === "CORRELATION TABLE"
    ? null
    : (record.title || null);
  const type = record.type || inferTypeFromCelex(record.celex);
  const normalizedTitle = normalizeText(title);
  const normalizedEli = normalizeText(record.eli);
  const normalizedCelex = normalizeText(record.celex);
  const { year, number } = extractYearNumberFromCelex(record.celex);
  const eliKind = getEliKind(record.eli);

  const enriched = {
    ...record,
    title,
    type,
    normalizedTitle,
    normalizedEli,
    normalizedCelex,
    celexYear: year,
    celexNumber: number,
    eliKind,
    isPrimaryAct: eliKind === "primary" && !isCorrigendumCelex(record.celex),
    fmxAvailable: Boolean(record.fmxAvailable),
    fmxUnavailable: Boolean(record.fmxUnavailable),
    enrichError: record.enrichError || null,
    // Recitals + Art. 1/2 body text for free-text recall (see search-build.js
    // buildExcerptFromCombined). Older cache records built before this field
    // existed won't have it — default to "" rather than undefined so it's
    // always safe to index/serialize.
    excerpt: typeof record.excerpt === "string" ? record.excerpt : ""
  };
  enriched.aliases = buildAliases(enriched);
  return enriched;
}

function determineMatchReason(law, parsed) {
  if (parsed.celex && law.celex === parsed.celex) return "celex_exact";
  if (law.aliases.includes(parsed.normalized) || law.aliases.includes(parsed.compact)) return "alias_exact";
  // Full titles used to be duplicated into aliases, so an exact-title query
  // historically reported alias_exact. Preserve that response contract without
  // indexing every long title two extra times.
  const normalizedTitle = normalizeText(law.title);
  if (normalizedTitle === parsed.normalized || compactText(law.title) === parsed.compact) {
    return "alias_exact";
  }
  if (parsed.type && parsed.year && parsed.number &&
      parsed.type === law.type &&
      parsed.year === law.celexYear &&
      parsed.number === law.celexNumber) {
    return "reference_exact";
  }
  if (normalizedTitle.includes(parsed.normalized) || compactText(law.title).includes(parsed.compact)) {
    return "title_phrase";
  }
  return "token_match";
}

module.exports = {
  KNOWN_ALIASES,
  QUERY_REWRITES,
  compactText,
  determineMatchReason,
  enrichSearchRecord,
  inferTypeFromCelex,
  normalizeText,
  parseStructuredQuery
};
