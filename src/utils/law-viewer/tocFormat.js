// Presentation helpers for the table-of-contents rail and the chapter eyebrow.
// Formex chapter titles usually arrive shouting in all-caps ("GENERAL
// PROVISIONS"); we render them in sentence case while preserving a small
// allow-list of acronyms and roman numerals so "EU" and "Title II" survive.

const ACRONYMS = ["EU", "EEA", "EC", "ECB", "ENISA", "AI", "GDPR"];
const ACRONYM_MAP = new Map(ACRONYMS.map((acronym) => [acronym.toUpperCase(), acronym]));

const ROMAN_NUMERAL = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;
const STRUCTURE_WORD = /^(chapter|title|part|section|subsection|annex)$/i;

export function isRomanNumeral(value) {
  const raw = String(value || "").trim();
  return raw.length > 0 && ROMAN_NUMERAL.test(raw);
}

function transformWord(core, isFirst) {
  const upper = core.toUpperCase();
  if (ACRONYM_MAP.has(upper)) return ACRONYM_MAP.get(upper);
  if (isRomanNumeral(core)) return upper;

  const lower = core.toLowerCase();
  if (!isFirst) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Sentence-case a title: first letter capitalised, the rest lower-cased, but
// acronyms from the allow-list and roman numerals keep their canonical casing.
export function sentenceCaseTitle(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let seenCore = false;
  return raw
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token) || token === "") return token;
      const lead = token.match(/^[^\p{L}\p{N}]*/u)[0];
      const trail = token.match(/[^\p{L}\p{N}]*$/u)[0];
      const core = token.slice(lead.length, token.length - trail.length);
      if (!core) return token;
      const isFirst = !seenCore;
      seenCore = true;
      return lead + transformWord(core, isFirst) + trail;
    })
    .join("");
}

// buildToc joins a division's number and title with " — ", so a chapter label
// looks like "I — General provisions" (or just a title when there is no
// number). Split it back into its quiet marker and its title.
export function splitChapterLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return { marker: "", title: "" };

  const parts = raw.split(" — ");
  if (parts.length >= 2) {
    return { marker: parts[0].trim(), title: parts.slice(1).join(" — ").trim() };
  }
  return { marker: "", title: raw };
}

// The compact glyph shown in the TOC gutter: strip a leading structure word so
// "CHAPTER I" collapses to "I", leaving a bare roman numeral or number.
export function getChapterMarker(label) {
  const { marker } = splitChapterLabel(label);
  if (!marker) return "";
  const tokens = marker.split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] || "";
  return last;
}

function toArticleNumber(article) {
  const parsed = Number.parseInt(String(article?.article_number ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// "Art. 1–2" range for a chapter, derived from its own items and any section
// items. Returns just the numeric range ("1–2", or "13" for a single article);
// the caller supplies the localised "Art." prefix.
export function getChapterArticleRange(chapter) {
  const numbers = [];
  for (const article of chapter?.items || []) {
    const value = toArticleNumber(article);
    if (value != null) numbers.push(value);
  }
  for (const section of chapter?.sections || []) {
    for (const article of section?.items || []) {
      const value = toArticleNumber(article);
      if (value != null) numbers.push(value);
    }
  }
  if (numbers.length === 0) return "";

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? String(min) : `${min}–${max}`;
}

// The uppercase eyebrow above the article title, e.g. "Chapter I — General
// provisions". `chapterWord` is the localised word "Chapter", only prefixed
// when the marker is a bare numeral/roman (not already textual).
export function buildChapterEyebrow(label, { chapterWord = "Chapter" } = {}) {
  const { marker, title } = splitChapterLabel(label);
  const casedTitle = sentenceCaseTitle(title);

  let markerPart = "";
  if (marker) {
    const isBareMarker = isRomanNumeral(marker) || /^\d+$/.test(marker);
    markerPart = isBareMarker ? `${chapterWord} ${marker.toUpperCase()}` : sentenceCaseTitle(marker);
  }

  if (markerPart && casedTitle) return `${markerPart} — ${casedTitle}`;
  return markerPart || casedTitle;
}
