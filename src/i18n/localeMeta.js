export const UI_LOCALE_STORAGE_KEY = "legalviz-ui-locale";

export const UI_LOCALES = {
  bg: { route: "bg", bcp47: "bg-BG", lawLang: "BG", nativeName: "Български" },
  cs: { route: "cs", bcp47: "cs-CZ", lawLang: "CS", nativeName: "Čeština" },
  da: { route: "da", bcp47: "da-DK", lawLang: "DA", nativeName: "Dansk" },
  de: { route: "de", bcp47: "de-DE", lawLang: "DE", nativeName: "Deutsch" },
  el: { route: "el", bcp47: "el-GR", lawLang: "EL", nativeName: "Ελληνικά" },
  en: { route: "en", bcp47: "en-GB", lawLang: "EN", nativeName: "English" },
  es: { route: "es", bcp47: "es-ES", lawLang: "ES", nativeName: "Español" },
  et: { route: "et", bcp47: "et-EE", lawLang: "ET", nativeName: "Eesti" },
  fi: { route: "fi", bcp47: "fi-FI", lawLang: "FI", nativeName: "Suomi" },
  fr: { route: "fr", bcp47: "fr-FR", lawLang: "FR", nativeName: "Français" },
  ga: { route: "ga", bcp47: "ga-IE", lawLang: "GA", nativeName: "Gaeilge" },
  hr: { route: "hr", bcp47: "hr-HR", lawLang: "HR", nativeName: "Hrvatski" },
  hu: { route: "hu", bcp47: "hu-HU", lawLang: "HU", nativeName: "Magyar" },
  it: { route: "it", bcp47: "it-IT", lawLang: "IT", nativeName: "Italiano" },
  lt: { route: "lt", bcp47: "lt-LT", lawLang: "LT", nativeName: "Lietuvių" },
  lv: { route: "lv", bcp47: "lv-LV", lawLang: "LV", nativeName: "Latviešu" },
  mt: { route: "mt", bcp47: "mt-MT", lawLang: "MT", nativeName: "Malti" },
  nl: { route: "nl", bcp47: "nl-NL", lawLang: "NL", nativeName: "Nederlands" },
  pl: { route: "pl", bcp47: "pl-PL", lawLang: "PL", nativeName: "Polski" },
  pt: { route: "pt", bcp47: "pt-PT", lawLang: "PT", nativeName: "Português" },
  ro: { route: "ro", bcp47: "ro-RO", lawLang: "RO", nativeName: "Română" },
  sk: { route: "sk", bcp47: "sk-SK", lawLang: "SK", nativeName: "Slovenčina" },
  sl: { route: "sl", bcp47: "sl-SI", lawLang: "SL", nativeName: "Slovenščina" },
  sv: { route: "sv", bcp47: "sv-SE", lawLang: "SV", nativeName: "Svenska" },
};

export const SUPPORTED_UI_LOCALES = Object.keys(UI_LOCALES);
export const RESERVED_ROOT_SEGMENTS = new Set(["import", "law"]);

export function normalizeUiLocale(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_UI_LOCALES.includes(normalized) ? normalized : "en";
}

export function uiLocaleFromLawLang(lawLang) {
  const target = String(lawLang || "").trim().toUpperCase();
  const entry = Object.entries(UI_LOCALES).find(([, meta]) => meta.lawLang === target);
  return entry ? entry[0] : "en";
}

export function lawLangFromUiLocale(locale) {
  return UI_LOCALES[normalizeUiLocale(locale)]?.lawLang || "EN";
}

export function isSupportedUiLocale(value) {
  return SUPPORTED_UI_LOCALES.includes(String(value || "").trim().toLowerCase());
}

export function getPathSegments(pathname) {
  return String(pathname || "/")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

export function isCompatibilityPath(pathname) {
  const [first] = getPathSegments(pathname);
  return RESERVED_ROOT_SEGMENTS.has(first || "");
}

export function isLocalizedHomepagePath(pathname) {
  const segments = getPathSegments(pathname);
  return segments.length === 1 && isSupportedUiLocale(segments[0]);
}

export function getRouteLocale(pathname) {
  const segments = getPathSegments(pathname);
  if (!segments.length) return null;

  const [first, second] = segments;
  if (isSupportedUiLocale(first) && (!second || !RESERVED_ROOT_SEGMENTS.has(second))) {
    return normalizeUiLocale(first);
  }

  return null;
}

export function stripLocalePrefix(pathname) {
  const segments = getPathSegments(pathname);
  if (!segments.length) return "/";
  if (!isSupportedUiLocale(segments[0])) return pathname || "/";
  const rest = segments.slice(1);
  return rest.length ? `/${rest.join("/")}` : "/";
}

export function isPublicPath(pathname) {
  const segments = getPathSegments(pathname);
  if (!segments.length) return true;

  const routeLocale = getRouteLocale(pathname);
  if (routeLocale) {
    const rest = segments.slice(1);
    return rest.length === 0 || rest.length === 1 || rest.length === 3;
  }

  if (RESERVED_ROOT_SEGMENTS.has(segments[0])) return false;
  return segments.length === 1 || segments.length === 3;
}

export function localizePath(pathname, locale = "en") {
  const normalizedLocale = normalizeUiLocale(locale);
  const cleanPath = pathname || "/";

  if (isCompatibilityPath(cleanPath)) return cleanPath;

  const basePath = stripLocalePrefix(cleanPath);
  if (normalizedLocale === "en") {
    return basePath === "/" ? "/" : basePath;
  }

  if (basePath === "/") return `/${normalizedLocale}`;
  return `/${normalizedLocale}${basePath}`;
}

export function getLocaleHomePath(locale = "en") {
  return normalizeUiLocale(locale) === "en" ? "/" : `/${normalizeUiLocale(locale)}`;
}
