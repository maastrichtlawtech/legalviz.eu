import { useI18n } from "../../i18n/useI18n.js";

/**
 * Explains that the reader is showing a consolidated ("as amended") text
 * because EUR-Lex publishes no structured text of the act as originally
 * adopted — see the fallback in `backend/shared/parsed-law-service.js`.
 *
 * Renders nothing unless that fallback actually fired, so callers can mount it
 * unconditionally. The no-recitals line is not optional copy: consolidated
 * texts carry no recitals at all, and without saying so the empty recital rail
 * reads as a bug rather than as what EUR-Lex published.
 *
 * `ConsolidationNotice` is the mirror image of this one and suppresses itself
 * for the same source, since "you are reading this law as adopted" is false here.
 */
export function ConsolidatedFallbackNotice({ source, consolidatedVersion = null }) {
  const { t } = useI18n();

  if (source !== "fmx-consolidated") return null;

  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
      <div className="font-medium">{t("lawViewer.consolidatedFallbackTitle")}</div>
      <p className="mt-1 leading-6">
        {consolidatedVersion?.date
          ? t("lawViewer.consolidatedFallbackMessageWithDate", { date: consolidatedVersion.date })
          : t("lawViewer.consolidatedFallbackMessage")}
      </p>
      <p className="mt-1 leading-6">{t("lawViewer.consolidatedFallbackNoRecitals")}</p>
    </div>
  );
}
