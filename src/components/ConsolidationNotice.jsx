import { ArrowLeft, ExternalLink, History, Loader2 } from "lucide-react";

import { useI18n } from "../i18n/useI18n.js";
import { useConsolidationStatus } from "../hooks/useConsolidationStatus.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";
import { buildEurlexCelexUrl } from "../utils/url.js";

/**
 * Tells the reader that the text on screen is the act as adopted, and that it
 * has since been amended — and, once a current consolidated version exists,
 * lets them switch to reading it (`?version=current`, #149's first slice).
 *
 * Everything LegalViz renders by default is the original published text; for
 * a heavily amended act that is the wrong answer to most practical questions,
 * and nothing in the reader said so before this notice. Historically the only
 * remedy was linking out to EUR-Lex — the consolidated text is a different
 * Formex schema this app didn't parse. It does now (the backend composes
 * consolidated articles with the as-adopted recitals, since EUR-Lex publishes
 * consolidated texts with none), so the toggle button is the primary action
 * and the EUR-Lex link stays only as a secondary escape hatch.
 *
 * Renders nothing at all when the act has never been amended, which is the
 * common case, and while the amendment history is still loading.
 *
 * `source: "fmx-consolidated"` is ambiguous by itself: it's stamped both by
 * the #170 fallback (the as-adopted act has no renderable content at all —
 * see `ConsolidatedFallbackNotice`) *and* by a reader-requested `?version=
 * current` load. Those need opposite copy — this notice's "you are reading
 * this law as adopted" is false in the first case and beside the point in the
 * second — so `version` (not `source`) is what's checked to tell them apart:
 * `version === "current"` means the reader asked for it and gets the reverse
 * banner below; a bare `fmx-consolidated` source with no requested version is
 * the forced #170 case and this notice stays silent, deferring to
 * `ConsolidatedFallbackNotice`.
 */
export function ConsolidationNotice({
  celex,
  currentLang = "EN",
  locale = "en",
  variant = "banner",
  source = null,
  version = null,
  versionUnavailable = false,
  versionDate = null,
  onToggleVersion = null,
}) {
  const { t } = useI18n();
  const isReadingRequestedVersion = version === "current";
  const isConsolidatedFallback = source === "fmx-consolidated" && !isReadingRequestedVersion;
  // Pass no celex when already reading the consolidated fallback or a
  // requested version, so the hook's amendment/consolidated-version fetches
  // don't fire for a notice that already knows what it's about to render.
  const status = useConsolidationStatus(
    isConsolidatedFallback || isReadingRequestedVersion ? null : celex
  );

  // The two lookups behind this notice do not land together: the amendment
  // history answers in a fraction of a second, the consolidated-version
  // SPARQL query takes seconds on a cold cache. Everything the reader can
  // *act* on hangs off the slower one, so without this the notice paints
  // complete and inert, and a button materialises out of nowhere a few
  // seconds later — the reader has no way to tell that anything is still in
  // progress, or that waiting is worth it. Occupying the action slot with an
  // honest "still checking" is the whole point: it is not decoration, it is
  // the difference between "nothing more is coming" and "not yet".
  const pendingAction = status.consolidatedStatusPending ? (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 text-inherit opacity-70"
    >
      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
      {t("consolidation.checkingVersion")}
    </span>
  ) : null;

  // Reverse state: the reader asked for the consolidated text and got it (or
  // didn't — `versionUnavailable` is the backend's honest "I tried and
  // couldn't", never a silent fallback). Neither branch touches
  // `useConsolidationStatus` above, so this can't contradict it.
  if (isReadingRequestedVersion) {
    const backAction = (
      <button
        type="button"
        onClick={() => onToggleVersion?.(null)}
        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        {t("consolidation.backToAsAdopted")}
      </button>
    );

    if (versionUnavailable) {
      const message = (
        <>
          <span>{t("consolidation.versionUnavailable")}</span> {backAction}
        </>
      );
      if (variant === "inline") {
        return (
          <p className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-amber-800 dark:text-amber-300">
            <History size={13} className="translate-y-px" aria-hidden="true" />
            {message}
          </p>
        );
      }
      return (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <History size={15} aria-hidden="true" />
            {t("consolidation.versionUnavailable")}
          </div>
          <p className="mt-1 leading-6">{backAction}</p>
        </div>
      );
    }

    const asOfDate = formatMetaDate(versionDate, locale);
    const readingSummary = asOfDate
      ? t("consolidation.readingAsAmendedWithDate", { date: asOfDate })
      : t("consolidation.readingAsAmended");

    if (variant === "inline") {
      return (
        <p className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-teal-800 dark:text-teal-300">
          <History size={13} className="translate-y-px" aria-hidden="true" />
          <span>{readingSummary}</span>
          {backAction}
        </p>
      );
    }
    return (
      <div className="mb-6 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-950 dark:border-teal-900/60 dark:bg-teal-950/20 dark:text-teal-100">
        <div className="flex items-center gap-2 font-medium">
          <History size={15} aria-hidden="true" />
          {readingSummary}
        </div>
        <p className="mt-1 leading-6">{backAction}</p>
      </div>
    );
  }

  if (isConsolidatedFallback) return null;

  // Never amended. Silence would be ambiguous — the reader cannot tell "we
  // checked and it is current" from "we did not check" — so the overview says
  // so positively. Only the overview: a reassurance repeated above every
  // article is noise, and the inline variant exists to warn, not to chat.
  if (!status.isOutdated) {
    if (variant === "inline") return null;
    // Say nothing until the history has actually answered. Claiming a law has
    // never been amended on the strength of a failed or in-flight fetch is
    // the same error as claiming no consolidated version exists.
    if (status.amendmentStatusPending || status.amendmentStatusUnknown) return null;

    const corrigenda = status.corrigendumCount;
    // A corrigendum-only act (the GDPR) is the one case where "not amended"
    // is true and still misleading: EUR-Lex applies corrigenda to the
    // consolidated text but not to the act as published, so the text on
    // screen really is uncorrected. Offer the same toggle, labelled for what
    // it actually does here — nothing was amended, the text was corrected.
    const canOfferCorrection = corrigenda > 0 && onToggleVersion;
    const correctionAction = (canOfferCorrection && pendingAction) ? pendingAction
      : (canOfferCorrection && status.consolidated) ? (
      <button
        type="button"
        onClick={() => onToggleVersion("current")}
        className="inline-flex items-center gap-1 font-semibold text-slate-900 underline underline-offset-2 hover:no-underline dark:text-slate-100"
      >
        {t("consolidation.toggleReadCorrected")}
      </button>
    ) : null;

    if (variant === "compact") {
      return (
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700 dark:text-slate-300">
          <History size={15} aria-hidden="true" />
          <strong className="font-semibold text-slate-900 dark:text-slate-100">
            {t("consolidation.currentText")}
          </strong>
          <span>
            {t("consolidation.notAmended")}
            {corrigenda > 0 ? (
              <> · {corrigenda === 1
                ? t("consolidation.corrigendumOnceShort")
                : t("consolidation.corrigendaShort", { count: corrigenda })}</>
            ) : null}
          </span>
          {correctionAction ? <span>{correctionAction}</span> : null}
        </div>
      );
    }

    return (
      <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
        <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
          <History size={15} aria-hidden="true" />
          {t("consolidation.upToDate")}
        </div>
        <p className="mt-1 leading-6">
          {t("consolidation.neverAmended")}
          {corrigenda > 0 ? (
            <> {corrigenda === 1
              ? t("consolidation.correctedOnce")
              : t("consolidation.corrected", { count: corrigenda })}</>
          ) : null}
        </p>
        {correctionAction ? <p className="mt-2 text-xs">{correctionAction}</p> : null}
      </div>
    );
  }

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

  // Secondary action: EUR-Lex still gets a direct link (no recital pairing,
  // no in-app navigation, but it's EUR-Lex's own authoritative page).
  const link = consolidatedUrl ? (
    <a
      href={consolidatedUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-amber-800/80 underline underline-offset-2 hover:no-underline dark:text-amber-300/70"
    >
      {t("consolidation.readConsolidated", { date: consolidatedOn })}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  ) : null;

  // Primary action: read it in-app. Only offered when a current consolidated
  // version actually exists to read (`consolidatedUrl`/`link`) — an act with
  // no published consolidation, or only a future-dated one, gets no toggle at
  // all, since `?version=current` would have nothing to switch to.
  const toggleButton = (consolidatedUrl && onToggleVersion) ? (
    <button
      type="button"
      onClick={() => onToggleVersion("current")}
      className="inline-flex items-center gap-1 font-semibold text-amber-950 underline underline-offset-2 hover:no-underline dark:text-amber-100"
    >
      {/* No icon: every branch of this notice already leads with a History
          glyph, and repeating it on the action reads as a second, unrelated
          marker rather than as emphasis. `backAction` carries an ArrowLeft
          for the same reason — a distinct icon earns its place, a repeated
          one does not. */}
      {t("consolidation.toggleReadAmended")}
    </button>
  ) : null;

  // No link means either: the query has not answered yet (say nothing), no
  // consolidated version has ever been published (say so), only future-dated
  // ones exist (say that instead, honestly), or the /consolidated fetch
  // itself failed (say nothing — we don't know).
  let noVersionMessage = null;
  if (!link) {
    if (status.consolidatedStatusPending) {
      // The query is still in flight — claiming either way would be a guess,
      // and the wrong guess flashes on every amended act before the toggle
      // appears.
      noVersionMessage = null;
    } else if (status.consolidatedStatusUnknown) {
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
        {toggleButton}
        {link}
        {pendingAction}
        {!link && noVersionMessage ? <span className="text-amber-700/80 dark:text-amber-300/70">{noVersionMessage}</span> : null}
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
        {!link && noVersionMessage ? <> {noVersionMessage}</> : null}
      </p>
      {toggleButton || link || pendingAction ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {toggleButton}
          {link}
          {pendingAction}
        </p>
      ) : null}
    </div>
  );
}
