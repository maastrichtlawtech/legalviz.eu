import { useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { buildEurlexCelexUrl } from "../utils/url.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";
import { buildLawDisplayLabel } from "../utils/lawDisplay.js";
import { MiniCitationGraph } from "./MiniCitationGraph.jsx";

const ROW_DIVIDERS = "divide-y divide-gray-100 dark:divide-gray-800";

/**
 * The list body of a single tab: the (optionally capped) rows, a "show all" /
 * "show less" toggle and an optional muted footer. Rendered with a `key` tied
 * to the active tab so its expand state resets when the user switches tabs.
 */
function SectionList({ rows, cap = 8, emptyText, footer = null, t }) {
  const [expanded, setExpanded] = useState(false);
  const items = rows || [];
  const visible = expanded ? items : items.slice(0, cap);

  if (items.length === 0) {
    return (
      <>
        <div className="py-2 text-xs italic text-gray-400 dark:text-gray-500">{emptyText}</div>
        {footer}
      </>
    );
  }

  return (
    <>
      <div className={ROW_DIVIDERS}>
        {visible.map((row, index) => (
          <div key={row.key ?? index}>{row}</div>
        ))}
      </div>
      {items.length > cap ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="w-full border-t border-gray-100 pt-2 text-left text-[11.5px] font-medium text-eu-blue transition hover:text-eu-blue-bright dark:border-gray-800 dark:text-eu-blue-bright"
        >
          {expanded ? t("lawOverview.showLess") : t("lawOverview.showAll", { count: items.length })}
        </button>
      ) : null}
      {footer}
    </>
  );
}

/**
 * Humanised amendment / implementing-act row: the act type + formatted date is
 * the visible identity, the raw CELEX code is demoted to a trailing mono chip,
 * and the whole row is an external link to EUR-Lex.
 */
function ActRow({ act, currentLang, locale, label }) {
  const eurlexUrl = buildEurlexCelexUrl(act.celex, currentLang);
  const dateLabel = formatMetaDate(act.date, locale);
  return (
    <a
      href={eurlexUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex w-full items-center gap-2 py-2 text-xs"
    >
      <span className="min-w-0 flex-1 truncate leading-snug text-gray-700 dark:text-gray-300">
        <span className="font-medium">{label}</span>
        {dateLabel ? (
          <span className="ml-2 tabular-nums text-gray-400 dark:text-gray-500">{dateLabel}</span>
        ) : null}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-gray-400 dark:text-gray-500">{act.celex}</span>
      <ExternalLink
        size={11}
        className="shrink-0 text-gray-300 transition group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-400"
      />
    </a>
  );
}

/**
 * Overview metadata: reverse citations, outgoing citations ("Cites"),
 * implementing/delegated acts and amendment history, shown as a single
 * full-width tabbed card. Consumes the shared useLawMetadata result (no
 * fetching of its own) plus the crossreference-derived linked-law overview.
 *
 * `citedBy` is the act-level citation-graph payload; when it is null (graph
 * unavailable or the fetch failed) the "Cited by" tab is omitted entirely and
 * the "Cites" tab becomes the default.
 */
export function MetadataPanel({
  amendments,
  implementing,
  externalLawOverview = [],
  citedBy = null,
  centreLabel = "",
  currentLang = "EN",
  locale = "en",
  onOpenExternalLaw,
  onOpenCitedLaw,
  isExternalReferencePending,
  t,
}) {
  const [activeTab, setActiveTab] = useState(null);
  const tabRefs = useRef({});

  const amendmentRows = (amendments || []).map((act) => (
    <ActRow
      key={act.celex}
      act={act}
      currentLang={currentLang}
      locale={locale}
      label={act.type === "corrigendum" ? t("amendmentHistory.corrigendum") : t("amendmentHistory.amendment")}
    />
  ));

  const implementingRows = (implementing || []).map((act) => (
    <ActRow
      key={act.celex}
      act={act}
      currentLang={currentLang}
      locale={locale}
      label={t("lawOverview.implDelActLabel")}
    />
  ));

  const linkedRows = (externalLawOverview || []).map((item) => {
    const pending = typeof isExternalReferencePending === "function"
      ? isExternalReferencePending(item.ref)
      : false;
    return (
      <button
        key={item.key}
        type="button"
        disabled={pending}
        onClick={() => onOpenExternalLaw?.(item.ref)}
        className={`flex w-full items-center gap-2 py-2 text-left text-xs ${pending ? "cursor-progress" : ""}`}
      >
        {pending ? <Loader2 size={12} className="shrink-0 animate-spin text-gray-400" /> : null}
        <span className="min-w-0 flex-1 truncate leading-snug text-gray-700 dark:text-gray-300">{item.label}</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500">
          {t("lawOverview.citedTimes", { count: item.count })}
        </span>
      </button>
    );
  });

  const citingLaws = citedBy?.citingLaws?.laws || [];
  const citedByRows = citingLaws.map((law) => {
    const { label, fullTitle } = buildLawDisplayLabel(law);
    return (
      <button
        key={law.celex}
        type="button"
        title={fullTitle || undefined}
        onClick={() => onOpenCitedLaw?.(law.celex, { label: law.title })}
        className="flex w-full items-center gap-2 py-2 text-left text-xs"
      >
        <span className="min-w-0 flex-1 truncate leading-snug text-gray-700 dark:text-gray-300">{label}</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500">
          {t("lawOverview.citedTimes", { count: law.provisions })}
        </span>
      </button>
    );
  });

  const citedByFooter = citedBy ? (
    <div className="mt-2 space-y-0.5 border-t border-gray-100 pt-2 text-[11px] text-gray-400 dark:border-gray-800 dark:text-gray-500">
      <div>
        {t("lawOverview.citedByCounts", {
          provisions: citedBy.totals?.provisions ?? 0,
          judgments: citedBy.totals?.judgments ?? 0,
        })}
      </div>
      <div>{t("citedBy.footnote")}</div>
    </div>
  ) : null;

  const tabs = [];
  if (citedBy) {
    tabs.push({ id: "citedBy", label: t("citedBy.title"), count: citedBy.citingLaws?.total ?? citedByRows.length });
  }
  tabs.push({ id: "cites", label: t("lawOverview.tabCites"), count: linkedRows.length });
  tabs.push({ id: "implementing", label: t("lawOverview.tabImplementing"), count: implementingRows.length });
  tabs.push({ id: "amendments", label: t("lawOverview.tabAmendments"), count: amendmentRows.length });

  // Default to "Cited by" when the graph is available, otherwise "Cites".
  // Falling back through `tabs.some(...)` keeps a user's manual choice sticky
  // yet re-derives the default as citedBy loads in asynchronously.
  const defaultTab = citedBy ? "citedBy" : "cites";
  const effectiveTab = activeTab && tabs.some((entry) => entry.id === activeTab) ? activeTab : defaultTab;
  const showCitationGraph = effectiveTab === "citedBy" && citingLaws.length > 0;

  const sections = {
    citedBy: { rows: citedByRows, emptyText: t("citedBy.empty"), footer: citedByFooter },
    cites: { rows: linkedRows, emptyText: t("lawOverview.linkedEmpty") },
    implementing: { rows: implementingRows, emptyText: t("lawOverview.implementingEmpty") },
    amendments: { rows: amendmentRows, emptyText: t("lawOverview.amendmentsEmpty") },
  };
  const active = sections[effectiveTab] || sections.cites;

  const handleTabKeyDown = (event) => {
    const index = tabs.findIndex((entry) => entry.id === effectiveTab);
    if (index < 0) return;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = tabs[(index + 1) % tabs.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    } else if (event.key === "Home") {
      next = tabs[0];
    } else if (event.key === "End") {
      next = tabs[tabs.length - 1];
    }
    if (next) {
      event.preventDefault();
      setActiveTab(next.id);
      tabRefs.current[next.id]?.focus();
    }
  };

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div
        role="tablist"
        aria-label={t("lawOverview.relatedTabsLabel")}
        className="flex flex-wrap border-b border-gray-200 px-2 dark:border-gray-800"
      >
        {tabs.map((entry) => {
          const isActive = effectiveTab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`metadata-tab-${entry.id}`}
              aria-selected={isActive}
              aria-controls="metadata-tabpanel"
              tabIndex={isActive ? 0 : -1}
              ref={(el) => {
                tabRefs.current[entry.id] = el;
              }}
              onClick={() => setActiveTab(entry.id)}
              onKeyDown={handleTabKeyDown}
              className={`-mb-px flex items-center gap-1.5 whitespace-nowrap rounded-sm border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-eu-blue/40 ${
                isActive
                  ? "border-eu-blue text-eu-blue dark:border-eu-blue-bright dark:text-eu-blue-bright"
                  : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-500 dark:hover:text-gray-300"
              }`}
            >
              {entry.label}
              <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500">{entry.count}</span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="metadata-tabpanel"
        aria-labelledby={`metadata-tab-${effectiveTab}`}
        className={showCitationGraph ? "p-0" : "px-4 py-2"}
      >
        {showCitationGraph ? (
          <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)]">
            <div className="px-4 py-2">
              <SectionList
                key={effectiveTab}
                rows={active.rows}
                emptyText={active.emptyText}
                footer={active.footer}
                t={t}
              />
            </div>
            <MiniCitationGraph
              laws={citingLaws}
              total={citedBy?.citingLaws?.total ?? citingLaws.length}
              centreLabel={centreLabel || citedBy?.celex}
              ariaLabel={t("citedBy.title")}
              formatMore={(count) => t("citedBy.andMore", { count })}
            />
          </div>
        ) : (
          <SectionList
            key={effectiveTab}
            rows={active.rows}
            emptyText={active.emptyText}
            footer={active.footer}
            t={t}
          />
        )}
      </div>
    </div>
  );
}
