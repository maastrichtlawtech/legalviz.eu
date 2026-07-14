import { useEffect, useState } from "react";
import { motion as Motion } from "framer-motion";
import { FilePlus2 } from "lucide-react";
import { Button } from "./Button.jsx";

const MOBILE_VISIBLE_LIMIT = 8;
const DESKTOP_VISIBLE_LIMIT = 10;

function formatOfficialReference(law) {
  const reference = law?.officialReference;
  if (reference?.actType && reference?.year && reference?.number) {
    const actTypeLabel = reference.actType.charAt(0).toUpperCase() + reference.actType.slice(1);
    return `${actTypeLabel} (EU) ${reference.year}/${reference.number}`;
  }

  const parts = String(law?.label || "").split(" — ").map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" — ") : "";
}

function getCardTitle(law) {
  const parts = String(law?.label || "").split(" — ").map((part) => part.trim()).filter(Boolean);
  return parts[0] || law?.label || "";
}

function getActTypeLabel(law, t) {
  const actType = String(law?.officialReference?.actType || "").toLowerCase();
  if (!actType) return null;
  if (actType === "regulation") return t("landing.regulation");
  if (actType === "directive") return t("landing.directive");
  if (actType === "decision") return t("landing.decision");
  return actType.charAt(0).toUpperCase() + actType.slice(1);
}

function getTimestampSortValue(law) {
  return Number.isFinite(law?.timestamp) ? law.timestamp : 0;
}

function getDayDifference(now, date) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfToday.getTime() - startOfTarget.getTime()) / 86400000);
}

function getRecentGroupLabel(law, locale, t) {
  const timestamp = getTimestampSortValue(law);
  if (!timestamp) return t("landing.never");

  const date = new Date(timestamp);
  const diffDays = getDayDifference(new Date(), date);
  if (diffDays === 0) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day");
  }
  if (diffDays === 1) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
  }
  if (diffDays <= 6) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: new Date().getFullYear() === date.getFullYear() ? undefined : "numeric",
  }).format(date);
}

function getGroupKey(law, locale) {
  const timestamp = getTimestampSortValue(law);
  if (!timestamp) return "missing";

  const date = new Date(timestamp);
  const diffDays = getDayDifference(new Date(), date);
  if (diffDays === 0) return `day:${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day")}`;
  if (diffDays === 1) return `day:${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day")}`;
  if (diffDays <= 6) {
    return `weekday:${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date)}`;
  }
  return `date:${new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: new Date().getFullYear() === date.getFullYear() ? undefined : "numeric",
  }).format(date)}`;
}

function groupLaws(laws, locale, t) {
  const sorted = [...laws].sort((left, right) => {
    const timeDiff = getTimestampSortValue(right) - getTimestampSortValue(left);
    if (timeDiff !== 0) return timeDiff;
    return (right.addedAt || 0) - (left.addedAt || 0);
  });

  const groups = [];
  for (const law of sorted) {
    const groupKey = getGroupKey(law, locale);
    const group = groups[groups.length - 1];
    if (group && group.key === groupKey) {
      group.laws.push(law);
      continue;
    }

    groups.push({
      key: groupKey,
      label: getRecentGroupLabel(law, locale, t),
      laws: [law],
    });
  }

  return groups;
}

function limitGroups(groups, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  let remaining = limit;
  const limitedGroups = [];

  for (const group of groups) {
    if (remaining <= 0) break;
    const visibleLaws = group.laws.slice(0, remaining);
    if (visibleLaws.length === 0) continue;

    limitedGroups.push({
      ...group,
      laws: visibleLaws,
    });
    remaining -= visibleLaws.length;
  }

  return limitedGroups;
}

function LawLibraryCard({ law, onOpen, t }) {
  const title = getCardTitle(law);
  const officialReference = formatOfficialReference(law);
  const actTypeLabel = getActTypeLabel(law, t);

  return (
    <Motion.div
      whileHover={{ y: -2, scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      onClick={() => onOpen(law)}
      className="group relative flex flex-col rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-gray-300 hover:shadow-md cursor-pointer dark:bg-gray-900 dark:border-gray-800 dark:hover:border-gray-700 dark:hover:shadow-gray-900/50"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(law);
        }
      }}
      role="button"
    >
      <div className="flex items-start justify-between gap-3 w-full">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </div>
          {officialReference ? (
            <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
              {officialReference}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {actTypeLabel ? (
              <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {actTypeLabel}
              </span>
            ) : null}
            {law?.celex ? (
              <span className="inline-flex rounded-full border border-gray-200 px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                CELEX {law.celex}
              </span>
            ) : null}
          </div>
          {Array.isArray(law?.topics) && law.topics.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {law.topics.slice(0, 3).map((topic) => (
                <span
                  key={topic}
                  className="max-w-[10rem] flex-shrink-0 truncate rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                >
                  {topic}
                </span>
              ))}
            </div>
          ) : null}
        </div>

      </div>
    </Motion.div>
  );
}

export function LandingLibrary({
  laws,
  onManualAddLaw,
  onOpenLaw,
  locale,
  t,
}) {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(min-width: 640px)").matches;
  });
  const [isExpanded, setIsExpanded] = useState(false);
  const recentGroups = groupLaws(laws, locale, t);
  const visibleLimit = isDesktop ? DESKTOP_VISIBLE_LIMIT : MOBILE_VISIBLE_LIMIT;
  const hasOverflow = laws.length > visibleLimit;
  const visibleGroups = isExpanded ? recentGroups : limitGroups(recentGroups, visibleLimit);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    const mediaQuery = window.matchMedia("(min-width: 640px)");
    const handleChange = (event) => {
      setIsDesktop(event.matches);
    };

    setIsDesktop(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    setIsExpanded(false);
  }, [visibleLimit, laws.length]);

  return (
    <>
      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-8 w-full"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
              {t("landing.recentTitle")}
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t("landing.recentDescription")}
            </p>
          </div>
          {onManualAddLaw ? (
            <Button
              type="button"
              variant="outline"
              className="inline-flex rounded-full px-4 sm:shrink-0"
              onClick={onManualAddLaw}
            >
              <FilePlus2 className="mr-2 h-4 w-4" />
              {t("landing.manualAddLaw")}
            </Button>
          ) : null}
        </div>
      </Motion.div>

      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-8 w-full"
      >
        <div className="relative space-y-5 sm:space-y-7 sm:pl-10">
          <div
            aria-hidden="true"
            className="absolute bottom-0 left-[1.375rem] top-2 hidden w-px bg-gray-200 dark:bg-gray-800 sm:block"
          />
          {visibleGroups.length > 0 ? visibleGroups.map((group) => (
            <div key={group.key} className="relative space-y-3">
              <div className="relative min-h-6">
                <span
                  aria-hidden="true"
                  className="absolute -left-6 top-1 hidden h-3 w-3 rounded-full border-2 border-white bg-gray-400 ring-4 ring-white dark:border-gray-900 dark:bg-gray-500 dark:ring-gray-950 sm:block"
                />
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                  {group.label}
                </h3>
              </div>
              <div className="space-y-3">
                {group.laws.map((law) => (
                  <LawLibraryCard
                    key={law.id}
                    law={law}
                    onOpen={onOpenLaw}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              {t("landing.recentEmpty")}
            </div>
          )}
        </div>
        {hasOverflow ? (
          <div className="mt-5 flex justify-start">
            <Button
              type="button"
              variant="outline"
              className="rounded-full px-4"
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded
                ? t("landing.recentShowLess")
                : t("landing.recentShowAll", { count: laws.length })}
            </Button>
          </div>
        ) : null}
      </Motion.div>
    </>
  );
}
