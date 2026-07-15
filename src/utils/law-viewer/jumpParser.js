// Parses the unified "jump box" input into a navigation target. Accepts, case-
// insensitively:
//   "23", "art 23", "art23", "art. 23", "article 23", "a23"  -> article 23
//   "rec 40", "rec40", "recital 40", "r40"                    -> recital 40
//   "annex 2", "anx 2", "annex2", "anx2"                      -> annex 2
// A bare number defaults to an article. Returns { kind, number } (number is a
// 1-based position) or null when nothing matches.

const PATTERNS = [
  { kind: "annex", re: /^(?:annex|anx)\.?\s*0*(\d+)$/ },
  { kind: "recital", re: /^(?:recital|rec|r)\.?\s*0*(\d+)$/ },
  { kind: "article", re: /^(?:article|art|a)\.?\s*0*(\d+)$/ },
  { kind: "article", re: /^0*(\d+)$/ },
];

export function parseJumpQuery(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  for (const { kind, re } of PATTERNS) {
    const match = raw.match(re);
    if (!match) continue;
    const number = Number.parseInt(match[1], 10);
    if (!Number.isFinite(number) || number < 1) return null;
    return { kind, number };
  }

  return null;
}
