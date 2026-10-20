import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, History, Loader2 } from "lucide-react";

import { useI18n } from "../i18n/useI18n.js";
import { useConsolidationStatus } from "../hooks/useConsolidationStatus.js";
import { formatAmendmentSummary } from "../utils/formatAmendmentSummary.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";
import { buildEurlexCelexUrl } from "../utils/url.js";

/**
 * Picks which text of the law the reader sees: as adopted, or the current
 * consolidated text (`?version=current`, #149's first slice). It sits in the
 * top bar beside the language picker because, like the language, it is a
 * property of the reading rather than of any one article.
 *
 * This replaced a banner that told the reader, in a paragraph above every
 * article, that they were reading the act as adopted. That framed an
 * ordinary choice between two texts as a warning. The chip shows the choice
 * as a selected option instead, and a dot on it marks that a newer text
 * exists. The overview carries the amendment facts as plain metadata
 * (`AmendmentStatusMeta`).
 *
 * Renders nothing when there is nothing to choose between: a law that has
 * never been amended or corrected, an amendment history that has not
 * answered (or failed — "nothing to choose" would be a guess), and the #170
 * fallback, where `source: "fmx-consolidated"` arrives with no requested
 * `version` because EUR-Lex has no as-adopted text at all. That last case is
 * a real warning and stays with `ConsolidatedFallbackNotice`.
 *
 * Corrigendum-only acts (the GDPR) are offered the same choice, labelled for
 * what it is: nothing was amended, but EUR-Lex applies corrigenda only to the
 * consolidated text, so the text as published really is uncorrected.
 */
export function VersionMenu({
  celex,
  currentLang = "EN",
  locale = "en",
  source = null,
  version = null,
  versionUnavailable = false,
  versionDate = null,
  onSelectVersion = null,
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const isReadingRequestedVersion = version === "current";
  const isConsolidatedFallback = source === "fmx-consolidated" && !isReadingRequestedVersion;
  const status = useConsolidationStatus(isConsolidatedFallback ? null : celex);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setIsOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (isConsolidatedFallback || !onSelectVersion) return null;

  const isCorrigendaOnly = !status.isOutdated && status.corrigendumCount > 0;
  if (!isReadingRequestedVersion) {
    if (status.amendmentStatusPending || status.amendmentStatusUnknown) return null;
    if (!status.isOutdated && !isCorrigendaOnly) return null;
  }

  const adoptedLabel = t(isCorrigendaOnly ? "consolidation.asPublished" : "consolidation.asAdopted");
  const currentLabel = t(isCorrigendaOnly ? "consolidation.withCorrections" : "consolidation.asAmended");
  // A requested version the backend could not serve leaves the as-adopted
  // text on screen, so that is what the chip must claim.
  const isShowingCurrent = isReadingRequestedVersion && !versionUnavailable;
  const chipLabel = isShowingCurrent ? currentLabel : adoptedLabel;

  const consolidatedDate = isShowingCurrent && versionDate ? versionDate : status.consolidated?.date;
  const consolidatedOn = formatMetaDate(consolidatedDate, locale);
  const consolidatedUrl = status.consolidated
    ? buildEurlexCelexUrl(status.consolidated.celex, currentLang)
    : null;
  const canReadCurrent = isShowingCurrent || versionUnavailable || !!status.consolidated;

  let currentDetail;
  if (versionUnavailable) {
    currentDetail = t("consolidation.versionUnavailableShort");
  } else if (canReadCurrent) {
    currentDetail = consolidatedOn
      ? t("consolidation.consolidatedOn", { date: consolidatedOn })
      : t("consolidation.consolidatedUndated");
  } else if (status.consolidatedStatusPending) {
    currentDetail = (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {t("consolidation.checkingVersion")}
      </span>
    );
  } else if (status.consolidatedStatusUnknown) {
    currentDetail = t("consolidation.consolidatedStatusUnknown");
  } else if (status.hasUpcomingConsolidation) {
    currentDetail = t("consolidation.consolidatedVersionPending");
  } else {
    currentDetail = t("consolidation.noConsolidatedVersion");
  }

  const adoptedDetail = isCorrigendaOnly
    ? (status.corrigendumCount === 1
      ? t("consolidation.corrigendumNotApplied")
      : t("consolidation.corrigendaNotApplied", { count: status.corrigendumCount }))
    : (status.isOutdated ? formatAmendmentSummary(status, locale, t) : null);

  const choose = (nextVersion) => {
    setIsOpen(false);
    // Re-selecting the current reading is a no-op, except retrying a
    // requested version that failed to load.
    if (nextVersion === "current" ? isShowingCurrent : !isReadingRequestedVersion) return;
    onSelectVersion(nextVersion);
  };

  const options = [
    {
      key: "current",
      label: currentLabel,
      detail: currentDetail,
      checked: isShowingCurrent,
      disabled: !canReadCurrent,
      onSelect: () => choose("current"),
    },
    {
      key: "adopted",
      label: adoptedLabel,
      detail: adoptedDetail,
      checked: !isShowingCurrent,
      disabled: false,
      onSelect: () => choose(null),
    },
  ];

  // Gold: a newer text exists and the reader is not on it. Teal: reading the
  // consolidated text. Neither is a warning colour; the one real failure
  // (`versionUnavailable`) is spelled out in the menu itself.
  const dotClass = isShowingCurrent
    ? "bg-teal-600 dark:bg-teal-400"
    : canReadCurrent
      ? "bg-eu-gold dark:bg-eu-gold-bright"
      : null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t("consolidation.chipLabel", { version: chipLabel })}
        title={t("consolidation.chipLabel", { version: chipLabel })}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800"
      >
        <span className="relative inline-flex">
          <History size={15} aria-hidden="true" />
          {dotClass ? (
            <span
              className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-gray-900 ${dotClass}`}
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="hidden font-medium lg:inline">{chipLabel}</span>
        <ChevronDown size={13} className="hidden text-gray-400 lg:inline" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div
          role="menu"
          aria-label={t("consolidation.menuLabel")}
          className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10"
        >
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("consolidation.menuLabel")}
          </p>
          {versionUnavailable ? (
            <p className="mx-2 mb-1 rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {t("consolidation.versionUnavailable")}
            </p>
          ) : null}
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.checked}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              onClick={option.onSelect}
              className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                option.checked
                  ? "bg-eu-blue-soft text-eu-blue dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright"
                  : option.disabled
                    ? "cursor-default text-gray-400 dark:text-gray-500"
                    : "text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
              }`}
            >
              <span className="mt-0.5 w-4 flex-shrink-0">
                {option.checked ? <Check size={15} aria-hidden="true" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.detail ? (
                  <span className="block text-xs leading-5 text-gray-500 dark:text-gray-400">{option.detail}</span>
                ) : null}
              </span>
            </button>
          ))}
          {consolidatedUrl ? (
            <a
              href={consolidatedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1.5 border-t border-gray-100 px-3 pb-1.5 pt-2.5 text-xs text-gray-500 hover:text-gray-800 dark:border-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {t("consolidation.readConsolidated", { date: formatMetaDate(status.consolidated.date, locale) })}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
