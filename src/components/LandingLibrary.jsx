import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion as Motion } from "framer-motion";
import { FilePlus2 } from "lucide-react";
import { Button } from "./Button.jsx";
import { getBundledLaws, getCanonicalLawRoute } from "../utils/lawRouting.js";

const MOBILE_VISIBLE_LIMIT = 4;
const DESKTOP_VISIBLE_LIMIT = 6;

const ESSENTIAL_SLUGS = ["dsa", "dma", "gdpr", "aia"];
const ESSENTIAL_DESCRIPTION_KEYS = {
  dsa: "landing.essentialsDsa",
  dma: "landing.essentialsDma",
  gdpr: "landing.essentialsGdpr",
  aia: "landing.essentialsAia",
};

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

function getTimestampSortValue(law) {
  return Number.isFinite(law?.timestamp) ? law.timestamp : 0;
}

const RELATIVE_UNITS = [
  ["year", 31536000000],
  ["month", 2592000000],
  ["week", 604800000],
  ["day", 86400000],
  ["hour", 3600000],
  ["minute", 60000],
];

function formatRelativeTime(timestamp, locale) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const diffMs = timestamp - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return rtf.format(0, "minute");
}

function getResumeLabel(lastPosition, t) {
  if (!lastPosition?.kind || !lastPosition?.id) return null;
  let label = null;
  if (lastPosition.kind === "article") label = t("landing.resumeArticle", { id: lastPosition.id });
  if (lastPosition.kind === "recital") label = t("landing.resumeRecital", { id: lastPosition.id });
  if (lastPosition.kind === "annex") label = t("landing.resumeAnnex", { id: lastPosition.id });
  if (!label) return null;
  return lastPosition.title ? `${label} — ${lastPosition.title}` : label;
}

function getProgressPercent(lastPosition) {
  if (!lastPosition || lastPosition.kind !== "article") return null;

  const total = Number(lastPosition.total);
  const current = Number(lastPosition.id);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current) || current <= 0) return null;

  return Math.max(4, Math.min(100, Math.round((current / total) * 100)));
}

function LawLibraryCard({ law, onOpen, locale, t }) {
  const title = getCardTitle(law);
  const officialReference = formatOfficialReference(law);
  const relativeTime = formatRelativeTime(getTimestampSortValue(law), locale);
  const topics = Array.isArray(law?.topics) ? law.topics.slice(0, 2) : [];

  const lastPosition = law?.lastPosition || null;
  const resumeLabel = getResumeLabel(lastPosition, t);
  const resumeRoute = resumeLabel
    ? getCanonicalLawRoute(law, lastPosition.kind, lastPosition.id, locale)
    : null;
  const progressPercent = getProgressPercent(lastPosition);

  return (
    <Motion.div
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.99 }}
      onClick={() => onOpen(law)}
      className="group relative flex cursor-pointer flex-col rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-eu-blue/40 hover:shadow-md dark:border-gray-800 dark:bg-panel-dark dark:hover:border-eu-blue/50"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(law);
        }
      }}
      role="button"
    >
      <div className="flex items-baseline gap-3">
        <h3 className="min-w-0 flex-1 truncate font-display text-base font-bold text-eu-navy dark:text-paper">
          {title}
        </h3>
        {relativeTime ? (
          <span className="flex-none text-[11px] text-gray-500 dark:text-gray-400">
            {relativeTime}
          </span>
        ) : null}
      </div>

      {officialReference || law?.celex ? (
        <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          {officialReference ? <span>{officialReference}</span> : null}
          {officialReference && law?.celex ? <span className="mx-1 text-gray-400">·</span> : null}
          {law?.celex ? (
            <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{law.celex}</span>
          ) : null}
        </div>
      ) : null}

      {progressPercent != null ? (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-eu-blue-soft dark:bg-eu-blue-soft-dark">
          <span className="block h-full rounded-full bg-eu-blue dark:bg-eu-blue-bright" style={{ width: `${progressPercent}%` }} />
        </div>
      ) : null}

      {resumeLabel && resumeRoute ? (
        <Link
          to={resumeRoute}
          onClick={(event) => event.stopPropagation()}
          className="mt-2.5 line-clamp-1 w-fit text-xs font-medium text-eu-blue transition hover:underline dark:text-eu-blue-bright"
        >
          {resumeLabel}
        </Link>
      ) : null}

      {topics.length > 0 ? (
        <div className="mt-2 truncate text-[11px] text-gray-400 dark:text-gray-500">
          {topics.join(" · ")}
        </div>
      ) : null}
    </Motion.div>
  );
}

function EssentialsShelf({ locale, t, excludeCelexes }) {
  const bundled = getBundledLaws();
  const cards = ESSENTIAL_SLUGS
    .map((slug) => bundled.find((law) => law.slug === slug))
    .filter(Boolean)
    .filter((law) => !excludeCelexes.has(law.celex));

  if (cards.length === 0) return null;

  return (
    <Motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="mt-12 w-full"
    >
      <div className="mb-4">
        <h2 className="font-display text-lg font-bold text-eu-navy dark:text-paper">
          {t("landing.essentialsTitle")}
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t("landing.essentialsSubtitle")}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((law) => (
          <Link
            key={law.slug}
            to={getCanonicalLawRoute(law, null, null, locale)}
            className="flex flex-col rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-eu-blue/40 hover:shadow-md dark:border-gray-800 dark:bg-panel-dark dark:hover:border-eu-blue/50"
          >
            <h3 className="font-display text-[15px] font-bold text-eu-navy dark:text-paper">
              {law.label}
            </h3>
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {formatOfficialReference(law)}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
              {t(ESSENTIAL_DESCRIPTION_KEYS[law.slug])}
            </p>
          </Link>
        ))}
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

  const sortedLaws = [...laws].sort((left, right) => {
    const timeDiff = getTimestampSortValue(right) - getTimestampSortValue(left);
    if (timeDiff !== 0) return timeDiff;
    return (right.addedAt || 0) - (left.addedAt || 0);
  });

  const visibleLimit = isDesktop ? DESKTOP_VISIBLE_LIMIT : MOBILE_VISIBLE_LIMIT;
  const hasOverflow = sortedLaws.length > visibleLimit;
  const visibleLaws = isExpanded ? sortedLaws : sortedLaws.slice(0, visibleLimit);
  const shownCelexes = new Set(sortedLaws.map((law) => law.celex).filter(Boolean));

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
        className="w-full"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-eu-navy dark:text-paper">
              {t("landing.continueTitle")}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t("landing.continueSubtitle")}
            </p>
          </div>
          {onManualAddLaw ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit rounded-full text-gray-600 dark:text-gray-300"
              onClick={onManualAddLaw}
            >
              <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
              {t("landing.addLawButton")}
            </Button>
          ) : null}
        </div>
      </Motion.div>

      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-5 w-full"
      >
        {visibleLaws.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleLaws.map((law) => (
              <LawLibraryCard
                key={law.id}
                law={law}
                onOpen={onOpenLaw}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-eu-blue-soft-dark/50 bg-eu-blue-soft/40 px-4 py-8 text-center text-sm text-gray-600 dark:border-panel-dark dark:bg-panel-dark/60 dark:text-gray-400">
            {t("landing.recentEmpty")}
          </div>
        )}
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
                : t("landing.recentShowAll", { count: sortedLaws.length })}
            </Button>
          </div>
        ) : null}
      </Motion.div>

      <EssentialsShelf locale={locale} t={t} excludeCelexes={shownCelexes} />
    </>
  );
}
