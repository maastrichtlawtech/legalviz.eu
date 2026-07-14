import React, { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "../i18n/useI18n.js";

function useRecitalLookup(allRecitals) {
  return useMemo(() => {
    const map = new Map();
    if (allRecitals) {
      for (const r of allRecitals) {
        map.set(r.recital_number, r);
      }
    }
    return map;
  }, [allRecitals]);
}

function RecitalTitle({ recital, t }) {
  const hasTitle = Boolean(String(recital.recital_title || "").trim());

  if (hasTitle) {
    return recital.recital_title;
  }

  return `${t("common.recital")} ${recital.recital_number}`;
}

function RecitalTitleList({ recitals, onSelectRecital, t }) {
  return (
    <p className="font-serif text-sm leading-7 text-gray-700 dark:text-gray-300">
      {recitals.map((recital, index) => {
        return (
          <React.Fragment key={recital.recital_number}>
            {index > 0 ? " " : null}
            <button
              type="button"
              className="inline text-left text-gray-700 underline decoration-gray-300 underline-offset-4 transition hover:text-blue-700 hover:decoration-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:text-gray-300 dark:decoration-gray-600 dark:hover:text-blue-300 dark:hover:decoration-blue-500 dark:focus:ring-offset-gray-950"
              onClick={() => onSelectRecital(recital)}
              title={`${t("common.recital")} ${recital.recital_number}`}
            >
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                ({recital.recital_number})
              </span>{" "}
              <RecitalTitle recital={recital} t={t} />
            </button>
            {index < recitals.length - 1 ? "," : "."}
          </React.Fragment>
        );
      })}
    </p>
  );
}

export function RelatedRecitals({ recitals, allRecitals, recitalTitlesLoading = false, onSelectRecital }) {
  const { t } = useI18n();

  const recitalLookup = useRecitalLookup(allRecitals);

  if (!recitals || recitals.length === 0) return null;
  const linkedRecitals = recitals.map((r) => recitalLookup.get(r.recital_number) || r);
  const showTitleLoading = recitalTitlesLoading
    && linkedRecitals.some((recital) => !String(recital.recital_title || "").trim());

  return (
    <div className="mt-8 px-6 md:px-12">
      <div className="border-y border-gray-200 py-5 dark:border-gray-800">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
              {t("relatedRecitals.title")}
            </h3>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
              {recitals.length}
            </span>
          </span>
          {showTitleLoading ? (
            <span className="flex shrink-0 items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              {t("relatedRecitals.loadingTitles")}
            </span>
          ) : null}
        </div>
        <RecitalTitleList
          recitals={linkedRecitals}
          onSelectRecital={onSelectRecital}
          t={t}
        />
      </div>
    </div>
  );
}

export function GeneralRecitals({ recitalNumbers, allRecitals, recitalTitlesLoading = false, onSelectRecital }) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const recitalLookup = useRecitalLookup(allRecitals);
  const recitals = useMemo(
    () => (recitalNumbers || [])
      .map((recitalNumber) => recitalLookup.get(recitalNumber))
      .filter(Boolean),
    [recitalLookup, recitalNumbers]
  );
  const showTitleLoading = recitalTitlesLoading
    && recitals.some((recital) => !String(recital.recital_title || "").trim());

  if (recitals.length === 0) return null;

  return (
    <div className="mt-6 px-6 md:px-12">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 border-y border-gray-200 py-3 text-left transition hover:border-blue-200 dark:border-gray-800 dark:hover:border-blue-900/70"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {t("relatedRecitals.generalTitle")}
          </span>
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-sm font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {recitals.length}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {showTitleLoading ? (
            <span className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              {t("relatedRecitals.loadingTitles")}
            </span>
          ) : null}
          <span
            aria-hidden="true"
            className={`text-sm text-gray-500 transition-transform dark:text-gray-400 ${isOpen ? "rotate-90" : ""}`}
          >
            &gt;
          </span>
        </span>
      </button>

      {isOpen ? (
        <div className="border-b border-gray-200 py-5 dark:border-gray-800">
          <RecitalTitleList
            recitals={recitals}
            onSelectRecital={onSelectRecital}
            t={t}
          />
        </div>
      ) : null}
    </div>
  );
}
