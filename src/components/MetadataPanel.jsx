import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { buildEurlexCelexUrl } from "../utils/url.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";
import { buildLawDisplayLabel } from "../utils/lawDisplay.js";
import { Pill } from "./ui/Pill.jsx";

function MetaCard({ title, count, subtitle, emptyText, rows, cap = 4, t }) {
  const [expanded, setExpanded] = useState(false);
  const items = rows || [];
  const visible = expanded ? items : items.slice(0, cap);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">{title}</span>
        <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500">{count}</span>
      </div>
      {subtitle ? (
        <div className="mb-1 text-[11px] text-gray-400 dark:text-gray-500">{subtitle}</div>
      ) : null}
      {items.length === 0 ? (
        <div className="border-t border-gray-100 pt-2 text-xs italic text-gray-400 dark:border-gray-800 dark:text-gray-500">
          {emptyText}
        </div>
      ) : (
        <div>
          {visible.map((row, index) => (
            <div key={row.key ?? index}>{row}</div>
          ))}
          {items.length > cap ? (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="w-full border-t border-gray-100 pt-2 text-left text-[11.5px] font-medium text-eu-blue transition hover:text-eu-blue-bright dark:border-gray-800 dark:text-eu-blue-bright"
            >
              {expanded ? t("lawOverview.showLess") : t("lawOverview.showAll", { count: items.length })}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ActRow({ act, currentLang, locale, variant, pillLabel }) {
  const eurlexUrl = buildEurlexCelexUrl(act.celex, currentLang);
  const dateLabel = formatMetaDate(act.date, locale);
  return (
    <a
      href={eurlexUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group block border-t border-gray-100 py-2 text-xs dark:border-gray-800"
    >
      <span className="flex items-center gap-2">
        <Pill variant={variant} className="shrink-0">{pillLabel}</Pill>
        <span className="whitespace-nowrap font-mono text-[11px] text-gray-700 dark:text-gray-300">
          {act.celex}
        </span>
        <ExternalLink size={11} className="ml-auto shrink-0 text-gray-300 transition group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-400" />
      </span>
      {dateLabel ? (
        <span className="mt-0.5 block text-[11px] tabular-nums text-gray-400 dark:text-gray-500">
          {dateLabel}
        </span>
      ) : null}
    </a>
  );
}

/**
 * Overview metadata cards: amendment history, implementing/delegated acts,
 * linked legislation and reverse citations. Consumes the shared useLawMetadata
 * result (no fetching of its own) plus the crossreference-derived linked-law
 * overview.
 *
 * `citedBy` is the act-level citation-graph payload; when it is null (graph
 * unavailable or the fetch failed) the card is omitted entirely rather than
 * rendered empty.
 */
export function MetadataPanel({
  amendments,
  implementing,
  externalLawOverview = [],
  citedBy = null,
  currentLang = "EN",
  locale = "en",
  onOpenExternalLaw,
  onOpenCitedLaw,
  isExternalReferencePending,
  t,
}) {
  const amendmentRows = (amendments || []).map((act) => (
    <ActRow
      key={act.celex}
      act={act}
      currentLang={currentLang}
      locale={locale}
      variant={act.type === "corrigendum" ? "corr" : "reg"}
      pillLabel={act.type === "corrigendum" ? t("lawOverview.corrShort") : t("lawOverview.amendShort")}
    />
  ));

  const implementingRows = (implementing || []).map((act) => (
    <ActRow
      key={act.celex}
      act={act}
      currentLang={currentLang}
      locale={locale}
      variant="reg"
      pillLabel={t("metadata.implDelBadge")}
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
        className={`flex w-full items-baseline gap-2 border-t border-gray-100 py-2 text-left text-xs dark:border-gray-800 ${
          pending ? "cursor-progress" : ""
        }`}
      >
        {pending ? <Loader2 size={12} className="shrink-0 animate-spin text-gray-400" /> : null}
        <span className="min-w-0 flex-1 leading-snug text-gray-700 dark:text-gray-300">{item.label}</span>
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
        className="flex w-full items-baseline gap-2 border-t border-gray-100 py-2 text-left text-xs dark:border-gray-800"
      >
        <span className="min-w-0 flex-1 leading-snug text-gray-700 dark:text-gray-300">{label}</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500">
          {t("lawOverview.citedTimes", { count: law.provisions })}
        </span>
      </button>
    );
  });
  const citedBySubtitle = citedBy
    ? t("lawOverview.citedByCounts", {
        provisions: citedBy.totals?.provisions ?? 0,
        judgments: citedBy.totals?.judgments ?? 0,
      })
    : null;

  return (
    <div className={`mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 ${citedBy ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      <MetaCard
        title={t("amendmentHistory.title")}
        count={amendmentRows.length}
        emptyText={t("lawOverview.amendmentsEmpty")}
        rows={amendmentRows}
        t={t}
      />
      <MetaCard
        title={t("metadata.implementingActs")}
        count={implementingRows.length}
        emptyText={t("lawOverview.implementingEmpty")}
        rows={implementingRows}
        t={t}
      />
      <MetaCard
        title={t("lawOverview.linkedLegislation")}
        count={linkedRows.length}
        emptyText={t("lawOverview.linkedEmpty")}
        rows={linkedRows}
        t={t}
      />
      {citedBy ? (
        <MetaCard
          title={t("citedBy.title")}
          count={citedBy.citingLaws?.total ?? citedByRows.length}
          subtitle={citedBySubtitle}
          emptyText={t("citedBy.empty")}
          rows={citedByRows}
          t={t}
        />
      ) : null}
    </div>
  );
}
