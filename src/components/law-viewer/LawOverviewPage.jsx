import { useState, useEffect, useCallback } from "react";
import { ExternalLink, Loader2, Scale } from "lucide-react";
import { LawSummary } from "../LawSummary.jsx";
import { MetadataPanel } from "../MetadataPanel.jsx";
import { CaseLawModal } from "../CaseLawModal.jsx";
import { ConsolidationNotice } from "../ConsolidationNotice.jsx";
import { ConsolidatedFallbackNotice } from "./ConsolidatedFallbackNotice.jsx";
import { formatMetaDate } from "../../utils/formatMetaDate.js";
import { Pill } from "../ui/Pill.jsx";
import { useLawMetadata } from "../../hooks/useLawMetadata.js";
import { useCaseLaw } from "../../hooks/law-viewer/useCaseLaw.js";

const ACT_TYPE_KEY = {
  regulation: "lawOverview.actTypeRegulation",
  directive: "lawOverview.actTypeDirective",
  decision: "lawOverview.actTypeDecision",
};

/**
 * CJEU case-law action for the overview header. Mirrors the sidebar
 * CaseLawButton's load-on-click / auto-open behavior, styled as an outline
 * button.
 */
function OverviewCaseLawButton({ celex, currentLang, t }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [autoOpenOnLoad, setAutoOpenOnLoad] = useState(false);
  const { cases, loading, loaded, trigger } = useCaseLaw(celex, { autoLoad: false });

  useEffect(() => { setAutoOpenOnLoad(false); }, [celex]);

  useEffect(() => {
    if (loaded && autoOpenOnLoad && cases && cases.length > 0) {
      setModalOpen(true);
      setAutoOpenOnLoad(false);
    }
  }, [loaded, autoOpenOnLoad, cases]);

  const load = useCallback(() => {
    if (!celex || loaded || loading) return;
    setAutoOpenOnLoad(true);
    trigger();
  }, [celex, loaded, loading, trigger]);

  if (!celex) return null;

  const hasCases = loaded && cases && cases.length > 0;
  const noCases = loaded && (!cases || cases.length === 0);

  const baseClass = "inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700";

  if (noCases) {
    return (
      <span className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500">
        <Scale size={16} />
        {t("metadata.caseLaw")} {t("common.noneFoundSuffix")}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={hasCases ? () => setModalOpen(true) : load}
        disabled={loading}
        className={baseClass}
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Scale size={16} />}
        {t("metadata.caseLaw")}
        {hasCases ? ` (${cases.length})` : ""}
      </button>
      {hasCases ? (
        <CaseLawModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          cases={cases}
          currentLang={currentLang}
          celex={celex}
        />
      ) : null}
    </>
  );
}

export function LawOverviewPage({
  currentLaw,
  data,
  effectiveCelex,
  formexLang,
  onArticleClick,
  onStartReading,
  externalLawOverview = [],
  onOpenExternalLaw,
  onOpenCitedLaw,
  isExternalReferencePending,
  locale = "en",
  version = null,
  versionUnavailable = false,
  versionDate = null,
  onToggleVersion,
  t,
}) {
  const meta = useLawMetadata(effectiveCelex);
  const { metadata, status } = meta;
  const procedureLabel = t("lawOverview.procedureView");

  const rawTitle = data.title || currentLaw?.label || "";
  // Labels often read "Common name — Regulation (EU) YYYY/N"; the reference
  // half is already carried by the pills and lede, so the H1 keeps only the
  // common name and the remainder falls back into the lede.
  const titleParts = rawTitle.split(" — ").map((part) => part.trim()).filter(Boolean);
  const title = titleParts[0] || rawTitle;
  const titleRemainder = titleParts.length > 1 ? titleParts.slice(1).join(" — ") : null;
  const officialReference = currentLaw?.officialReference;
  const actTypeLabel = officialReference?.actType && ACT_TYPE_KEY[officialReference.actType]
    ? t(ACT_TYPE_KEY[officialReference.actType])
    : null;
  const lede = officialReference?.raw && officialReference.raw !== rawTitle
    ? officialReference.raw
    : titleRemainder;

  const articleCount = data.articles?.length || 0;
  const recitalCount = data.recitals?.length || 0;
  const annexCount = data.annexes?.length || 0;
  const countParts = [
    articleCount ? `${articleCount} ${t("common.articles").toLowerCase()}` : null,
    recitalCount ? `${recitalCount} ${t("common.recitals").toLowerCase()}` : null,
    annexCount ? `${annexCount} ${t("common.annexes").toLowerCase()}` : null,
  ].filter(Boolean);

  const entryDates = (metadata?.entryIntoForce || []).map((d) => formatMetaDate(d, locale)).filter(Boolean);
  // When EUR-Lex reports several dates (entry into force, then start of
  // application), the practitioner's question is the latest one.
  const appliesFrom = entryDates.length ? entryDates[entryDates.length - 1] : null;
  const eliShort = metadata?.eli ? metadata.eli.replace("http://data.europa.eu/eli/", "") : null;

  return (
    <div>
      {/* Eyebrow: act type + status pills, CELEX chip */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {actTypeLabel ? <Pill variant="reg">{actTypeLabel}</Pill> : null}
        {status ? (
          status.inForce ? (
            <Pill variant="ok">{t("metadata.inForce")}</Pill>
          ) : status.notYetInForce ? (
            <Pill variant="warn">
              {t("metadata.notYetInForce")}
              {status.startsOn ? ` · ${formatMetaDate(status.startsOn, locale)}` : ""}
            </Pill>
          ) : (
            <Pill variant="muted">
              {t("metadata.notInForce")}
              {status.endedOn ? ` · ${formatMetaDate(status.endedOn, locale)}` : ""}
            </Pill>
          )
        ) : null}
        {effectiveCelex ? (
          <span className="inline-block rounded font-mono text-[11px] tracking-wide text-eu-blue bg-eu-blue-soft px-[7px] py-px dark:text-eu-blue-bright dark:bg-eu-blue-soft-dark">
            {t("lawOverview.celexLabel", { celex: effectiveCelex })}
          </span>
        ) : null}
      </div>

      <h1 className="mb-2 font-display text-3xl font-bold leading-tight tracking-tight text-eu-navy dark:text-paper md:text-4xl">
        {title}
      </h1>

      {lede ? (
        <p className="mb-3 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">{lede}</p>
      ) : null}

      {/* Meta row */}
      <div className="mb-6 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        {appliesFrom ? (
          <span>{t("lawOverview.appliesFrom")} <b className="font-semibold text-gray-800 dark:text-gray-200">{appliesFrom}</b></span>
        ) : null}
        {countParts.length ? <span>{countParts.join(" · ")}</span> : null}
        {eliShort ? (
          <a
            href={metadata.eli}
            target="_blank"
            rel="noopener noreferrer"
            className="text-eu-blue hover:underline dark:text-eu-blue-bright"
          >
            ELI: {eliShort}
          </a>
        ) : null}
      </div>

      <ConsolidationNotice
        celex={effectiveCelex}
        currentLang={formexLang}
        locale={locale}
        variant="compact"
        source={data?.source}
        version={version}
        versionUnavailable={versionUnavailable}
        versionDate={versionDate}
        onToggleVersion={onToggleVersion}
      />

      <ConsolidatedFallbackNotice
        source={data?.source}
        consolidatedVersion={data?.consolidatedVersion}
        version={version}
      />

      {/* Actions */}
      <div className="mb-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onStartReading}
          className="inline-flex items-center gap-2 rounded-xl bg-eu-navy px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          {t("lawViewer.startReading")}
          <span aria-hidden="true">→</span>
        </button>
        <OverviewCaseLawButton celex={effectiveCelex} currentLang={formexLang} t={t} />
        {meta.procedure?.procedureUrl ? (
          <a
            href={meta.procedure.procedureUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={meta.procedure.reference ? `${procedureLabel} · ${meta.procedure.reference}` : procedureLabel}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <ExternalLink size={16} />
            {procedureLabel}
          </a>
        ) : null}
      </div>

      <LawSummary celex={effectiveCelex} lang={formexLang} version={version} onArticleClick={onArticleClick} />

      <MetadataPanel
        amendments={meta.amendments}
        implementing={meta.implementing}
        externalLawOverview={externalLawOverview}
        citedBy={meta.citedBy}
        centreLabel={currentLaw?.label || title}
        currentLang={formexLang}
        locale={locale}
        onOpenExternalLaw={onOpenExternalLaw}
        onOpenCitedLaw={onOpenCitedLaw}
        isExternalReferencePending={isExternalReferencePending}
        t={t}
      />
    </div>
  );
}
