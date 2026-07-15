/**
 * Get the canonical law slug from the current URL path.
 * Expects format: /:slug
 */
export const getLawSlugFromPath = (pathname) => {
  const basePath = "";
  const pathWithoutBase = pathname.replace(basePath, "");
  const match = pathWithoutBase.match(/^\/(?!law\/|import(?:\/|$))([^/]+)/);
  return match ? match[1] : null;
};

function toEurlexLang(langCode) {
  return (langCode || "EN").slice(0, 2).toLowerCase();
}

export function buildEurlexSearchUrl(text, langCode = "EN") {
  if (!text) return null;

  const searchParams = new URLSearchParams({
    scope: "EURLEX",
    text,
    lang: toEurlexLang(langCode),
    type: "quick",
    qid: String(Date.now()),
  });

  return `https://eur-lex.europa.eu/search.html?${searchParams.toString()}`;
}

export function buildEurlexOjUrl({ ojColl, ojYear, ojNo, langCode = "EN" }) {
  if (!ojColl || !ojYear || !ojNo) return null;
  return `https://eur-lex.europa.eu/legal-content/${toEurlexLang(langCode).toUpperCase()}/TXT/?uri=OJ:${ojColl}:${ojYear}:${ojNo}:TOC`;
}

export function buildEurlexCelexUrl(celex, langCode = "EN") {
  if (!celex) return null;
  return `https://eur-lex.europa.eu/legal-content/${toEurlexLang(langCode).toUpperCase()}/TXT/?uri=CELEX:${celex}`;
}
