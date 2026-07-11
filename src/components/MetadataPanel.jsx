import React, { useState, useCallback, useEffect } from "react";
import { Loader2, ChevronDown, ExternalLink, Scale } from "lucide-react";
import { fetchLawMetadata, fetchAmendments, fetchImplementingActs } from "../utils/formexApi.js";
import { buildEurlexCelexUrl } from "../utils/url.js";
import { Accordion } from "./Accordion.jsx";
import { CaseLawModal } from "./CaseLawModal.jsx";
import { useI18n } from "../i18n/useI18n.js";
import { useCaseLaw } from "../hooks/law-viewer/useCaseLaw.js";

/**
 * Prominent case law button + modal. Designed to be placed at the top of the sidebar.
 */
export function CaseLawButton({ celex, currentLang = "EN" }) {
  const { t } = useI18n();
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

  // After loading: show open-modal button, or "none found"
  if (loaded && cases && cases.length > 0) {
    return (
      <>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex w-full items-center justify-between rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-sm font-medium text-teal-900 transition hover:border-teal-300 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-100 dark:hover:border-teal-700 dark:hover:bg-teal-950/70"
        >
          <span className="flex items-center gap-2">
            <Scale size={16} />
            {t("metadata.caseLaw")} ({cases.length})
            <span className="rounded bg-teal-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-800 dark:bg-teal-800 dark:text-teal-200">{t("common.beta")}</span>
          </span>
        </button>
        <CaseLawModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          cases={cases}
          currentLang={currentLang}
          celex={celex}
        />
      </>
    );
  }

  if (loaded && (!cases || cases.length === 0)) {
    return (
      <div className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500">
        <Scale size={16} />
        {t("metadata.caseLaw")} {t("common.noneFoundSuffix")}
      </div>
    );
  }

  // Not yet loaded: show load button
  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="flex w-full items-center justify-between rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-sm font-medium text-teal-900 transition hover:border-teal-300 hover:bg-teal-100 disabled:opacity-60 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-100 dark:hover:border-teal-700 dark:hover:bg-teal-950/70"
    >
      <span className="flex items-center gap-2">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Scale size={16} />}
        {t("metadata.caseLaw")}
        <span className="rounded bg-teal-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-800 dark:bg-teal-800 dark:text-teal-200">{t("common.beta")}</span>
      </span>
    </button>
  );
}

function formatDate(isoDate) {
  if (!isoDate) return null;
  try {
    return new Date(isoDate).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}

const STATUS_BADGE = {
  true: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  false: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const TYPE_BADGE = {
  corrigendum: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  amendment: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

/**
 * A button that loads data on click and shows a loading spinner.
 */
// Renders with the same shell as Accordion so there's no layout shift on load
function LoadButton({ label, count, loading, loaded, onClick }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:bg-gray-800 dark:border-gray-700">
      <button
        type="button"
        onClick={!loaded && !loading ? onClick : undefined}
        disabled={loading}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium dark:text-gray-200 disabled:opacity-60"
      >
        <span className="flex items-center gap-2">
          {loading && <Loader2 size={12} className="animate-spin text-gray-400" />}
          {label}
          {loaded && count === 0 && (
            <span className="text-xs font-normal text-gray-400 dark:text-gray-500">{t("common.noneFoundSuffix")}</span>
          )}
        </span>
        {!loaded && !loading && <ChevronDown size={16} />}
      </button>
    </div>
  );
}

/**
 * Renders a list of acts (amendments or implementing acts) as cards.
 */
function ActList({ acts, currentLang, type = "amendment" }) {
  const { t } = useI18n();
  if (!acts || acts.length === 0) return null;

  return (
    <ul className="space-y-2">
      {acts.map((a) => {
        const eurlexUrl = buildEurlexCelexUrl(a.celex, currentLang);
        const dateLabel = formatDate(a.date);
        const badgeCls = type === "implementing"
          ? "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300"
          : (TYPE_BADGE[a.type] || TYPE_BADGE.amendment);
        const typeLabel = type === "implementing"
          ? t("metadata.implDelBadge")
          : (a.type === "corrigendum" ? t("amendmentHistory.corrigendum") : t("amendmentHistory.amendment"));

        return (
          <li key={a.celex}>
            <a
              href={eurlexUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col gap-0.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs transition hover:border-gray-300 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
            >
              <div className="flex items-center gap-1.5">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badgeCls}`}>
                  {typeLabel}
                </span>
                {dateLabel && (
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                    {dateLabel}
                  </span>
                )}
                <ExternalLink size={10} className="ml-auto shrink-0 text-gray-300 group-hover:text-gray-400 dark:text-gray-600 dark:group-hover:text-gray-500" />
              </div>
              <span className="font-medium text-gray-700 group-hover:text-blue-700 dark:text-gray-300 dark:group-hover:text-blue-400 truncate">
                {a.title || a.celex}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sidebar panel showing law metadata (dates, in-force status) fetched on mount,
 * plus on-demand buttons for amendments and implementing/delegated acts.
 */
export function MetadataPanel({ celex, currentLang = "EN" }) {
  const { t } = useI18n();

  // Metadata (auto-fetched when celex changes)
  const [metadata, setMetadata] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaLoaded, setMetaLoaded] = useState(false);

  // Amendments (on-demand)
  const [amendments, setAmendments] = useState(null);
  const [amendLoading, setAmendLoading] = useState(false);
  const [amendLoaded, setAmendLoaded] = useState(false);

  // Implementing acts (on-demand)
  const [implActs, setImplActs] = useState(null);
  const [implLoading, setImplLoading] = useState(false);
  const [implLoaded, setImplLoaded] = useState(false);

  // Auto-fetch metadata when celex changes
  useEffect(() => {
    if (!celex) return;

    // Reset all state for new celex
    setMetadata(null);
    setMetaLoaded(false);
    setAmendments(null);
    setAmendLoaded(false);
    setImplActs(null);
    setImplLoaded(false);
    let cancelled = false;
    setMetaLoading(true);
    fetchLawMetadata(celex)
      .then((result) => { if (!cancelled) setMetadata(result); })
      .catch(() => { if (!cancelled) setMetadata(null); })
      .finally(() => {
        if (!cancelled) {
          setMetaLoading(false);
          setMetaLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [celex]);

  const loadAmendments = useCallback(async () => {
    if (!celex || amendLoaded) return;
    setAmendLoading(true);
    try {
      const result = await fetchAmendments(celex);
      setAmendments(result.amendments || []);
    } catch {
      setAmendments([]);
    } finally {
      setAmendLoading(false);
      setAmendLoaded(true);
    }
  }, [celex, amendLoaded]);

  const loadImplementing = useCallback(async () => {
    if (!celex || implLoaded) return;
    setImplLoading(true);
    try {
      const result = await fetchImplementingActs(celex);
      setImplActs(result.acts || []);
    } catch {
      setImplActs([]);
    } finally {
      setImplLoading(false);
      setImplLoaded(true);
    }
  }, [celex, implLoaded]);

  if (!celex) return null;

  return (
    <div className="pt-4 space-y-3">
      {/* EU Metadata accordion — auto-fetched */}
      <Accordion
        title={t("metadata.title")}
        defaultOpen={false}
      >
        {metaLoading && (
          <div className="py-2 text-sm text-gray-400 dark:text-gray-500 animate-pulse">
            {t("metadata.loading")}
          </div>
        )}

        {metaLoaded && metadata && (
          <div className="space-y-2 text-xs">
            {/* In-force status — derived from endOfValidity (reliable) not the CDM boolean (unreliable after amendments) */}
            {(() => {
              const eov = metadata.endOfValidity;
              // 9999-12-31 is Cellar's sentinel for "open-ended" (still in force)
              const noLongerInForce = eov && eov !== "9999-12-31" && new Date(eov) < new Date();
              if (!noLongerInForce) return null; // don't show anything when in force — it's the normal/expected state
              return (
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 dark:text-gray-400">{t("metadata.status")}:</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[false]}`}>
                    {t("metadata.notInForce")}
                  </span>
                </div>
              );
            })()}

            {/* Entry into force date(s) */}
            {metadata.entryIntoForce?.length > 0 && (
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                <span className="text-gray-500 dark:text-gray-400">{t("metadata.entryIntoForce")}:</span>
                <span className="text-gray-700 dark:text-gray-300 tabular-nums">
                  {metadata.entryIntoForce.map(formatDate).join(", ")}
                </span>
              </div>
            )}

            {/* End of validity — only show if it's a real (finite) date */}
            {metadata.endOfValidity && metadata.endOfValidity !== "9999-12-31" && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400">{t("metadata.endOfValidity")}:</span>
                <span className="text-gray-700 dark:text-gray-300 tabular-nums">
                  {formatDate(metadata.endOfValidity)}
                </span>
              </div>
            )}

            {/* Date of document */}
            {metadata.dateDocument && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400">{t("metadata.dateOfDocument")}:</span>
                <span className="text-gray-700 dark:text-gray-300 tabular-nums">
                  {formatDate(metadata.dateDocument)}
                </span>
              </div>
            )}

            {/* EEA relevance */}
            {metadata.eea && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400">{t("metadata.eea")}:</span>
                <span className="text-gray-700 dark:text-gray-300">{t("metadata.yes")}</span>
              </div>
            )}

            {/* ELI link */}
            {metadata.eli && (
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-gray-500 dark:text-gray-400">ELI:</span>
                <a
                  href={metadata.eli}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 break-all"
                >
                  {metadata.eli.replace("http://data.europa.eu/eli/", "")}
                </a>
              </div>
            )}
          </div>
        )}

        {metaLoaded && !metadata && (
          <div className="py-2 text-sm text-gray-400 dark:text-gray-500">
            {t("metadata.unavailable")}
          </div>
        )}
      </Accordion>

      {/* Amendment History — load on demand */}
      {amendLoaded && amendments && amendments.length > 0 ? (
        <Accordion
          title={t("amendmentHistory.title")}
          defaultOpen={true}
        >
          <ActList acts={amendments} currentLang={currentLang} type="amendment" />
        </Accordion>
      ) : (
        <LoadButton
          label={t("amendmentHistory.title")}
          count={amendments?.length ?? 0}
          loading={amendLoading}
          loaded={amendLoaded}
          onClick={loadAmendments}
        />
      )}

      {/* Implementing / Delegated Acts — load on demand */}
      {implLoaded && implActs && implActs.length > 0 ? (
        <Accordion
          title={t("metadata.implementingActs")}
          defaultOpen={true}
        >
          <ActList acts={implActs} currentLang={currentLang} type="implementing" />
        </Accordion>
      ) : (
        <LoadButton
          label={t("metadata.implementingActs")}
          count={implActs?.length ?? 0}
          loading={implLoading}
          loaded={implLoaded}
          onClick={loadImplementing}
        />
      )}

    </div>
  );
}
