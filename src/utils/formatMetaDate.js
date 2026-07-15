/**
 * Format an ISO date in the active UI locale. English keeps the day-month-year
 * order (en-GB) that reads best for legal dates; other locales use their own.
 */
export function formatMetaDate(isoDate, locale = "en") {
  if (!isoDate) return null;
  try {
    const intlLocale = locale === "en" ? "en-GB" : locale;
    return new Date(isoDate).toLocaleDateString(intlLocale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}
