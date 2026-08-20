import { ExternalLink, History } from "lucide-react";

import { useI18n } from "../i18n/useI18n.js";
import { useConsolidationStatus } from "../hooks/useConsolidationStatus.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";
import { buildEurlexCelexUrl } from "../utils/url.js";

/**
 * Tells the reader that the text on screen is the act as adopted, and that it
 * has since been amended.
 *
 * Everything LegalViz renders is the original published text; for a heavily
 * amended act that is the wrong answer to most practical questions, and nothing
 * in the reader said so. The consolidated text itself is not rendered here (it
 * is a different Formex schema, and EUR-Lex strips the recitals this app is
 * built around) — so the notice links out to it rather than pretending.
 *
 * Renders nothing at all when the act has never been amended, which is the
 * common case, and while the amendment history is still loading.
 *
 * Also renders nothing when `source` is `"fmx-consolidated"` — that means the
 * reader is already looking at the consolidated text (the as-adopted act had
 * no renderable content, so `resolveParsedLaw` fell back to a consolidated
 * version; see `ConsolidatedFallbackNotice`). This notice's copy ("you are
 * reading this law as adopted") would be false in that case.
 */
export function ConsolidationNotice({ celex, currentLang = "EN", locale = "en", variant = "banner", source = null }) {
  const { t } = useI18n();
  const isConsolidatedFallback = source === "fmx-consolidated";
  // Pass no celex when already reading the consolidated fallback, so the
  // hook's amendment/consolidated-version fetches don't fire for a notice
  // that is about to render nothing anyway.
  const status = useConsolidationStatus(isConsolidatedFallback ? null : celex);

  if (isConsolidatedFallback) return null;
  if (!status.isOutdated) return null;

  const amendedOn = formatMetaDate(status.latestAmendmentDate, locale);
  const consolidatedOn = formatMetaDate(status.consolidated?.date, locale);
  const consolidatedUrl = status.consolidated
    ? buildEurlexCelexUrl(status.consolidated.celex, currentLang)
    : null;

  // The catalog carries no plural machinery, so the singular is its own key.
  // A truncated amendment count is a lower bound, never an exact number (see
  // `truncated` in fetchAmendments), so it gets its own "at least N" copy
  // rather than risk stating a precise-looking figure that is provably wrong.
  const once = status.amendmentCount === 1 && status.amendmentCountExact;
  const summaryKey = amendedOn
    ? (status.amendmentCountExact
      ? (once ? "consolidation.amendedOnceWithDate" : "consolidation.amendedWithDate")
      : "consolidation.amendedAtLeastWithDate")
    : (status.amendmentCountExact
      ? (once ? "consolidation.amendedOnce" : "consolidation.amended")
      : "consolidation.amendedAtLeast");
  const summary = t(summaryKey, { count: status.amendmentCount, date: amendedOn });

  const link = consolidatedUrl ? (
    <a
      href={consolidatedUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline"
    >
      {t("consolidation.readConsolidated", { date: consolidatedOn })}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  ) : null;

  // No link means either: no consolidated version has ever been published
  // (say so), only future-dated ones exist (say that instead, honestly), or
  // the /consolidated fetch itself failed (say nothing — we don't know).
  let noVersionMessage = null;
  if (!link) {
    if (status.consolidatedStatusUnknown) {
      noVersionMessage = null;
    } else if (status.hasUpcomingConsolidation) {
      noVersionMessage = t("consolidation.consolidatedVersionPending");
    } else {
      noVersionMessage = t("consolidation.noConsolidatedVersion");
    }
  }

  if (variant === "inline") {
    return (
      <p className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-amber-800 dark:text-amber-300">
        <History size={13} className="translate-y-px" aria-hidden="true" />
        <span>{t("consolidation.asAdopted")}</span>
        <span className="text-amber-700/80 dark:text-amber-300/70">{summary}</span>
        {link}
      </p>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
      <div className="flex items-center gap-2 font-medium">
        <History size={15} aria-hidden="true" />
        {t("consolidation.asAdopted")}
      </div>
      <p className="mt-1 leading-6">
        {summary}
        {link ? <> {link}</> : (noVersionMessage ? <> {noVersionMessage}</> : null)}
      </p>
    </div>
  );
}
