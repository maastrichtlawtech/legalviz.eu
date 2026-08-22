import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { motion as Motion } from "framer-motion";
import { Github } from "lucide-react";
import { TopBar, SearchBox } from "./TopBar.jsx";
import { SEO } from "./SEO.jsx";
import { LandingLibrary } from "./LandingLibrary.jsx";
import { McpLandingTeaser } from "./McpPromo.jsx";
import { useI18n } from "../i18n/useI18n.js";
import { lawLangFromUiLocale, uiLocaleFromLawLang } from "../i18n/localeMeta.js";
import { resetWholeApp } from "../utils/resetApp.js";
import { useLandingLibrary } from "../hooks/useLandingLibrary.js";
import { useLandingSearchIndex } from "../hooks/useLandingSearchIndex.js";
import { buildImportedLawCandidate, getCanonicalLawRoute } from "../utils/lawRouting.js";
import { saveLawMeta } from "../utils/library.js";
import { fetchDatasetMeta } from "../utils/formexApi.js";
import { formatMetaDate } from "../utils/formatMetaDate.js";

function inferOfficialReferenceFromCelex(celex) {
  const match = String(celex || "").match(/^3(\d{4})([RLD])0*(\d{1,4})(?:\(\d+\))?$/);
  if (!match) return null;

  const actTypeMap = {
    R: "regulation",
    L: "directive",
    D: "decision",
  };

  const actType = actTypeMap[match[2]] || null;
  if (!actType) return null;

  return {
    actType,
    year: match[1],
    number: String(Number.parseInt(match[3], 10)),
  };
}

export function Landing({ forcedLocale = null }) {
  const navigate = useNavigate();
  const { locale, setLocale, localizePath, t } = useI18n();
  const { allLaws, libraryVersion, markLawOpened } = useLandingLibrary();
  const formexLang = lawLangFromUiLocale(locale);

  useEffect(() => {
    if (forcedLocale && forcedLocale !== locale) {
      setLocale(forcedLocale);
    }
  }, [forcedLocale, locale, setLocale]);

  const handleUnifiedLanguageChange = useCallback((nextLang) => {
    setLocale(uiLocaleFromLawLang(nextLang));
  }, [setLocale]);

  const {
    allLawsData,
    handleSearchOpen,
    isSearchLoading,
    searchableLawCount,
  } = useLandingSearchIndex({
    formexLang,
    laws: allLaws,
    libraryVersion,
  });
  const activeLocale = forcedLocale || locale;

  // Best-effort footer note: fetched lazily after mount, never blocks
  // rendering, and stays hidden on failure or when no build date is
  // available — no error UI for what's just a nice-to-have footnote.
  const [datasetGeneratedAt, setDatasetGeneratedAt] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchDatasetMeta()
      .then((meta) => {
        if (!cancelled) setDatasetGeneratedAt(meta?.data?.generatedAt || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenLaw = useCallback(async (law) => {
    // Best-effort bookkeeping: never let a stuck IndexedDB block navigation.
    markLawOpened(law.celex).catch(() => {});
    navigate(localizePath(law.route, locale));
  }, [locale, localizePath, markLawOpened, navigate]);

  const handleSearchNavigate = useCallback(async (item) => {
    if (item.search_kind === "definition") {
      const source = item.representativeSource || {};
      if (!source.celex) return;
      const sourceArticle = source.article ?? source.sourceArticle;
      const targetLaw = buildImportedLawCandidate({
        celex: source.celex,
        title: source.title || source.law?.title,
        officialReference: inferOfficialReferenceFromCelex(source.celex),
      });
      const route = getCanonicalLawRoute(targetLaw, sourceArticle ? "article" : null, sourceArticle || null, locale);
      const separator = route.includes("?") ? "&" : "?";
      const term = item.normalizedTerm || item.term;
      const params = new URLSearchParams({ definition: term });
      params.set("definitionSource", `${String(source.celex).toUpperCase()}:${String(sourceArticle ?? "")}${source.sourcePoint ? `:${String(source.sourcePoint)}` : ""}`);
      navigate(`${route}${separator}${params.toString()}`);
      return;
    }

    if (item.search_kind === "fulltext") {
      const celex = String(item.celex || "").trim();
      const unitType = String(item.unitType || "").trim().toLowerCase();
      const number = item.number == null ? "" : String(item.number).trim();
      if (!celex || !number || (unitType !== "article" && unitType !== "recital")) return;

      const officialReference = inferOfficialReferenceFromCelex(celex);
      const targetLaw = buildImportedLawCandidate({
        celex,
        title: item.title,
        officialReference,
      });
      if (officialReference) {
        saveLawMeta({
          celex,
          label: item.title,
          officialReference,
        }).catch(() => {});
      }
      navigate(getCanonicalLawRoute(targetLaw, unitType, number, locale));
      return;
    }

    if (item.search_kind === "law") {
      const officialReference = inferOfficialReferenceFromCelex(item.celex);
      const targetLaw = buildImportedLawCandidate({
        celex: item.celex,
        title: item.title,
        officialReference,
      });

      if (officialReference) {
        // Best-effort bookkeeping: never let a stuck IndexedDB block navigation.
        saveLawMeta({
          celex: item.celex,
          label: item.title,
          officialReference,
          topics: item.topics,
        }).catch(() => {});
      }

      navigate(getCanonicalLawRoute(targetLaw, null, null, locale));
      return;
    }

    const safeId = encodeURIComponent(String(item.id));
    const targetLawSlug = item.law_slug || item.law_key;
    if (targetLawSlug) {
      navigate(localizePath(`/${targetLawSlug}/${item.type}/${safeId}`, locale));
    }
  }, [locale, localizePath, navigate]);

  return (
    <div className="min-h-screen bg-paper dark:bg-paper-dark transition-colors duration-500">
      <SEO description={t("seo.landingDescription")} />
      <TopBar
        lawKey=""
        title=""
        lists={allLawsData}
        eurlexUrl={null}
        showPrint={false}
        onSearchOpen={handleSearchOpen}
        isSearchLoading={isSearchLoading}
        formexLang={formexLang}
        searchableLawCount={searchableLawCount}
        onFormexLangChange={handleUnifiedLanguageChange}
        hasCelex={true}
        onResetApp={resetWholeApp}
        showSearch={false}
      />

      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col items-center justify-center px-6 py-10">
        <Motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex w-full max-w-4xl flex-col items-center text-center"
        >
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-eu-gold-deep dark:text-eu-gold-bright">
            {t("landing.heroEyebrow")}
          </span>

          <h1 className="mt-4 max-w-3xl text-balance font-display text-4xl font-bold leading-[1.08] tracking-tight text-eu-navy sm:text-5xl lg:text-[3.25rem] dark:text-paper">
            {t("landing.heroTitle")}{" "}
            <span className="italic text-eu-blue dark:text-eu-blue-bright">{t("landing.heroSubtitle")}</span>
          </h1>

          <p className="mt-4 max-w-xl text-pretty text-base text-gray-600 dark:text-gray-300">
            {t("landing.heroDescription")}
          </p>

          <div className="mt-8 w-full max-w-3xl">
            <SearchBox
              lists={allLawsData}
              onNavigate={handleSearchNavigate}
              onSearchOpen={handleSearchOpen}
              isSearchLoading={isSearchLoading}
              activeLanguage={formexLang}
              searchableLawCount={searchableLawCount}
              triggerVariant="hero"
              searchModes={locale === "en"
                ? ["laws", "matches", "definitions", "fulltext"]
                : ["laws", "matches", "definitions"]}
            />
          </div>
        </Motion.div>

        <div className="mt-14 w-full max-w-5xl">
          <LandingLibrary
            laws={allLaws}
            onOpenLaw={handleOpenLaw}
            locale={activeLocale}
            t={t}
          />
        </div>

        <div className="mt-10 flex justify-center">
          <McpLandingTeaser />
        </div>

        <Motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-10 flex flex-col items-center gap-2 text-center text-xs text-gray-500"
        >
          <p>{t("landing.builtBy")}</p>
          <a
            href="https://github.com/maastrichtlawtech/eur-lex-visualiser"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-gray-600 transition hover:text-gray-900 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <Github className="h-4 w-4" />
            <span>{t("landing.sourceCode")}</span>
          </a>
          {datasetGeneratedAt && (
            <p className="text-gray-400 dark:text-gray-600">
              {t("landing.datasetUpdated", { date: formatMetaDate(datasetGeneratedAt, activeLocale) })}
            </p>
          )}
        </Motion.div>
      </div>
    </div>
  );
}
