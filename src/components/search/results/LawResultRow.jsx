import { lawStatus } from "../../../utils/lawStatus.js";
import { cleanLawTitle, extractShortLawTitle, formatOfficialReference } from "../../../utils/lawDisplay.js";
import { inferOfficialReferenceFromCelex } from "../../../utils/library.js";

function getLawResultDisplay(item) {
  const officialReference = inferOfficialReferenceFromCelex(item.celex);
  const referenceLabel = formatOfficialReference(officialReference);
  const rawTitle = String(item.title || "").replace(/\s+/g, " ").trim();
  const cleanedTitle = cleanLawTitle(rawTitle, referenceLabel);
  const shortTitle = extractShortLawTitle(cleanedTitle || rawTitle);
  const primaryTitle = shortTitle && referenceLabel
    ? `${shortTitle} — ${referenceLabel}`
    : shortTitle
      ? shortTitle
      : referenceLabel || rawTitle || item.celex;
  const secondaryTitle = cleanedTitle && cleanedTitle !== primaryTitle
    ? cleanedTitle
    : rawTitle && rawTitle !== primaryTitle
      ? rawTitle
      : "";
  const metaLine = [item.date, item.celex].filter(Boolean).join(" · ");

  return {
    primaryTitle,
    secondaryTitle,
    referenceLabel,
    metaLine,
  };
}

export function LawResultRow({ item, t, dense }) {
  const lawDisplay = getLawResultDisplay(item);
  return (
    <>
      <div className="flex w-full min-w-0 items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate font-display font-bold ${dense ? "text-[14px]" : "text-[15px]"} ${
          lawStatus(item) === "notInForce"
            ? "text-gray-400 dark:text-gray-500"
            : "text-eu-navy dark:text-white"
        }`}>
          {lawDisplay?.primaryTitle || item.title}
        </span>
        {item.directCelex && (
          <span className="flex-shrink-0 rounded-full bg-eu-gold-soft px-2 py-0.5 text-[10px] font-medium text-eu-gold-deep dark:bg-eu-gold-soft-dark dark:text-eu-gold-bright">
            {t("search.openDirectly")}
          </span>
        )}
        {item.law_label && (
          <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            {item.law_label}
          </span>
        )}
        {/* Four states, and `null` is one of them: Cellar has no
            status for ~13% of the corpus, and drawing nothing is the
            only honest answer there. See lawStatus() for why `false`
            alone is not enough to say "no longer". */}
        {lawStatus(item) === "inForce" && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" aria-hidden="true" />
            {t("search.inForce")}
          </span>
        )}
        {lawStatus(item) === "notYetInForce" && (
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            title={t("search.entryIntoForce").replace("{date}", item.entryIntoForce)}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
            {t("search.notYetInForce")}
          </span>
        )}
        {lawStatus(item) === "notInForce" && (
          <span
            className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            title={item.endOfValidity ? t("search.endOfValidity").replace("{date}", item.endOfValidity) : undefined}
          >
            {t("search.notInForce")}
          </span>
        )}
      </div>
      {lawDisplay?.secondaryTitle ? (
        <p className={`text-xs leading-relaxed line-clamp-2 ${
          lawStatus(item) === "notInForce"
            ? "text-gray-400 dark:text-gray-500"
            : "text-gray-500 dark:text-gray-400"
        }`}>
          {lawDisplay.secondaryTitle}
        </p>
      ) : null}
      {lawDisplay?.metaLine ? (
        <p className="font-mono text-[11px] text-gray-400 dark:text-gray-500">
          {lawDisplay.metaLine}
        </p>
      ) : null}
      {Array.isArray(item.topics) && item.topics.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {item.topics.slice(0, 3).map((topic) => (
            <span
              key={topic}
              className="max-w-[10rem] flex-shrink-0 truncate rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            >
              {topic}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}