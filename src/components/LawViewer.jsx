import React, { useEffect, useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { buildEurlexCelexUrl } from "../utils/url.js";
import { parseOfficialReference } from "../utils/officialReferences.js";
import { markLawOpened, saveLawMeta } from "../utils/library.js";
import {
  getFontPercent,
  getProseClass,
  getSelectionTitle,
  getTextClass,
} from "../utils/law-viewer/content.js";
import { getSelectedEntry } from "../utils/law-viewer/selection.js";

import { Button } from "./Button.jsx";
import { TopBar } from "./TopBar.jsx";
import { PrintModal } from "./PrintModal.jsx";
import { SEO } from "./SEO.jsx";
import { GeneralRecitals, RelatedRecitals } from "./RelatedRecitals.jsx";
import { RelatedCaseLaw } from "./RelatedCaseLaw.jsx";
import { CrossReferences } from "./CrossReferences.jsx";
import { CitedByPanel } from "./CitedByPanel.jsx";
import { useI18n } from "../i18n/useI18n.js";
import { useLandingLibrary } from "../hooks/useLandingLibrary.js";
import { useLandingSearchIndex } from "../hooks/useLandingSearchIndex.js";
import { useLawViewerPreferences } from "../hooks/law-viewer/useLawViewerPreferences.js";
import { useLawViewerSource } from "../hooks/law-viewer/useLawViewerSource.js";
import { useLawDocument } from "../hooks/law-viewer/useLawDocument.js";
import { useSecondaryLawDocument } from "../hooks/law-viewer/useSecondaryLawDocument.js";
import { useLawSelection } from "../hooks/law-viewer/useLawSelection.js";
import { useLawViewerInteractions } from "../hooks/law-viewer/useLawViewerInteractions.js";
import { useRecitalMap } from "../hooks/law-viewer/useRecitalMap.js";
import { useProcessedLawHtml } from "../hooks/law-viewer/useProcessedLawHtml.js";
import { useLawViewerDerivedState } from "../hooks/law-viewer/useLawViewerDerivedState.js";
import { useLawViewerPrint } from "../hooks/law-viewer/useLawViewerPrint.js";
import { useDefinitionComparison } from "../hooks/law-viewer/useDefinitionComparison.js";
import { EU_LANGUAGES } from "../utils/formexApi.js";
import { getCanonicalLawRoute } from "../utils/lawRouting.js";
import { getEmptyContentDetails } from "../utils/law-viewer/errors.js";
import { buildChapterEyebrow } from "../utils/law-viewer/tocFormat.js";
import { LawViewerLoadingState } from "./law-viewer/LawViewerLoadingState.jsx";
import { LawViewerErrorState } from "./law-viewer/LawViewerErrorState.jsx";
import { LawViewerSidebar } from "./law-viewer/LawViewerSidebar.jsx";
import { LawViewerSideBySide } from "./law-viewer/LawViewerSideBySide.jsx";
import { DefinitionTooltip } from "./law-viewer/DefinitionTooltip.jsx";
import { LawViewerReadingFooter } from "./law-viewer/LawViewerReadingFooter.jsx";
import { LawViewerContextRail } from "./law-viewer/LawViewerContextRail.jsx";
import { LawOverviewPage } from "./law-viewer/LawOverviewPage.jsx";
import { ConsolidatedFallbackNotice } from "./law-viewer/ConsolidatedFallbackNotice.jsx";
import { DefinitionComparisonSheet } from "./law-viewer/DefinitionComparisonSheet.jsx";
import { ConsolidationNotice } from "./ConsolidationNotice.jsx";

export function LawViewer() {
  const { locale: routeLocale, slug, key, kind, id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { locale, setLocale, localizePath, t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  // Parallel-language reading collapses the chapter rail to buy column width;
  // this lets the reader pull the titled rail back without leaving the mode.
  const [isRailExpanded, setIsRailExpanded] = React.useState(false);
  const importCelex = searchParams.get("celex");
  const sourceUrl = searchParams.get("sourceUrl");
  const definitionTerm = searchParams.get("definition") || "";
  const definitionSource = searchParams.get("definitionSource") || "";
  // Only the literal "current" is a recognised version (#149's first slice;
  // the backend 400s on anything else) — treat any other value as unset
  // rather than forwarding garbage to the document hooks.
  const requestedVersion = searchParams.get("version") === "current" ? "current" : null;
  const { allLaws, libraryVersion } = useLandingLibrary();

  const preferences = useLawViewerPreferences({
    locale,
    setLocale,
    pathname: location.pathname,
    searchParams,
    setSearchParams,
  });

  const source = useLawViewerSource({
    slug,
    key,
    kind,
    id,
    importCelex,
    sourceUrl,
    locale,
    routeLocale,
    pathname: location.pathname,
    locationSearch: location.search,
    navigate,
    formexLang: preferences.formexLang,
    t,
    localizePath,
  });

  const primaryDocument = useLawDocument({
    celex: source.effectiveCelex,
    lang: preferences.formexLang,
    t,
    version: requestedVersion,
  });
  const secondaryDocument = useSecondaryLawDocument({
    celex: source.effectiveCelex,
    secondaryLang: preferences.secondaryLang,
    t,
    version: requestedVersion,
  });
  const selection = useLawSelection({
    data: primaryDocument.data,
    kind,
    id,
    celex: source.effectiveCelex,
    navigateToCanonical: source.navigateToCanonical,
  });
  const interactions = useLawViewerInteractions({
    data: primaryDocument.data,
    selected: selection.selected,
    onPrevNext: selection.onPrevNext,
    currentContentLang: primaryDocument.data.langCode || preferences.formexLang,
    locale,
  });

  const recitalMap = useRecitalMap({
    data: primaryDocument.data,
    currentLaw: source.currentLaw,
  });
  const primarySelectedEntry = useMemo(
    () => getSelectedEntry(primaryDocument.data, selection.selected),
    [primaryDocument.data, selection.selected]
  );
  // Set by the backend (`?version=current`) on an article inserted by
  // amendment with no as-adopted counterpart: nothing has ever been mapped to
  // it, so the case-law/cited-by rails must say why they're empty instead of
  // rendering as if the article were simply unremarkable.
  const isSelectedArticleInsertedInVersion = selection.selected.kind === "article"
    && !!primarySelectedEntry?.insertedInVersion;
  const processedHtml = useProcessedLawHtml({
    data: primaryDocument.data,
    selected: selection.selected,
    selectedEntry: primarySelectedEntry,
    activeDefinitionTerm: definitionTerm,
  });
  const secondarySelectedEntry = useMemo(
    () => getSelectedEntry(secondaryDocument.data, selection.selected),
    [secondaryDocument.data, selection.selected]
  );
  const secondaryProcessedHtml = useProcessedLawHtml({
    data: secondaryDocument.data,
    selected: selection.selected,
    selectedEntry: secondarySelectedEntry,
  });

  const {
    allLawsData,
    handleSearchOpen,
    isSearchLoading,
    searchableLawCount,
  } = useLandingSearchIndex({
    formexLang: preferences.formexLang,
    laws: allLaws,
    libraryVersion,
  });
  const activeLoadError = source.loadError || primaryDocument.loadError;
  const derived = useLawViewerDerivedState({
    source,
    primaryDocument,
    preferences,
    selection,
    sourceUrl,
    searchParams,
    slug,
    key,
    activeLoadError,
    t,
  });
  const displayedFormexLang = derived.documentLang || preferences.formexLang;
  const printState = useLawViewerPrint({
    data: primaryDocument.data,
    locale,
    t,
  });
  const definitionComparisonState = useDefinitionComparison(definitionTerm, t);

  const openDefinitionComparison = React.useCallback(({ term }) => {
    const normalizedTerm = String(term || "").trim();
    if (!normalizedTerm) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("definition", normalizedTerm);
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const closeDefinitionComparison = React.useCallback(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("definition");
    nextParams.delete("definitionSource");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  // Toggles `?version=current` on the URL, which is what makes a consolidated
  // reading shareable/bookmarkable and lets it survive article navigation
  // (state derived from the URL, not held in a component). Pushes a history
  // entry (no `replace`) so the back button can undo the toggle, the same as
  // navigating between articles does.
  const setVersion = React.useCallback((nextVersion) => {
    const nextParams = new URLSearchParams(searchParams);
    if (nextVersion) nextParams.set("version", nextVersion);
    else nextParams.delete("version");
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const definitionComparison = definitionTerm ? {
    term: definitionTerm,
    comparison: definitionComparisonState.comparison,
    selectedSource: definitionSource,
    loading: definitionComparisonState.loading,
    error: definitionComparisonState.error,
    onRetry: definitionComparisonState.retry,
    onClose: closeDefinitionComparison,
    onOpenSource: (celex, sourceArticle, sourcePoint) => {
      const sourceKey = `${String(celex || "").toUpperCase()}:${String(sourceArticle ?? "")}${sourcePoint ? `:${String(sourcePoint)}` : ""}`;
      const comparisonParams = new URLSearchParams({
        definition: definitionTerm,
        definitionSource: sourceKey,
      });
      interactions.handleOpenLawByCelex(celex, {
        articleNumber: sourceArticle,
        queryParams: comparisonParams,
      });
    },
  } : null;

  const { secondaryLang, setSecondaryLanguage } = preferences;
  useEffect(() => {
    if (!derived.isLegacyHtmlFallback || !secondaryLang) return;
    setSecondaryLanguage(null);
  }, [derived.isLegacyHtmlFallback, secondaryLang, setSecondaryLanguage]);

  useEffect(() => {
    if (!source.effectiveCelex || !derived.hasLoadedContent) return;
    // Only persist metadata once the loaded document actually corresponds to
    // the current law.  When navigating to a linked law, `effectiveCelex`
    // changes a render before the document refetches, so `primaryDocument.data`
    // still holds the previous law's title — saving here would overwrite the
    // new law's name with the old one.
    if (primaryDocument.data.celex !== source.effectiveCelex) return;
    const rawReference = searchParams.get("raw");
    const officialReference = source.currentLaw?.officialReference || parseOfficialReference(rawReference || "");
    saveLawMeta({
      celex: source.effectiveCelex,
      raw: rawReference,
      officialReference,
      label: rawReference || primaryDocument.data.title || source.currentLaw?.label || `CELEX ${source.effectiveCelex}`,
      eurlex: buildEurlexCelexUrl(
        source.effectiveCelex,
        primaryDocument.data.langCode || preferences.formexLang
      ),
    }).then(() => markLawOpened(source.effectiveCelex));
  }, [
    derived.hasLoadedContent,
    preferences.formexLang,
    primaryDocument.data.celex,
    primaryDocument.data.langCode,
    primaryDocument.data.title,
    searchParams,
    source.currentLaw,
    source.effectiveCelex,
  ]);

  // Route back to the law's overview (position-zero of the contents).
  const overviewRoute = useMemo(
    () => getCanonicalLawRoute(
      source.currentLaw || (source.effectiveCelex ? { celex: source.effectiveCelex } : null),
      "overview",
      null,
      locale
    ),
    [source.currentLaw, source.effectiveCelex, locale]
  );
  const goToOverview = useMemo(() => () => navigate(overviewRoute), [navigate, overviewRoute]);

  // The chapter that owns the selected article, independent of the TOC's
  // open/closed state, so the eyebrow/breadcrumb stay stable.
  const currentChapterLabel = useMemo(() => {
    if (selection.selected.kind !== "article") return null;
    const id = selection.selected.id;
    const chapter = selection.toc.find((entry) => (
      entry.items?.some((article) => article.article_number === id)
      || entry.sections?.some((section) => section.items?.some((article) => article.article_number === id))
    ));
    const label = chapter?.label;
    if (!label || label === "(Untitled Chapter)") return null;
    return label;
  }, [selection.selected, selection.toc]);
  const chapterEyebrow = useMemo(
    () => (currentChapterLabel ? buildChapterEyebrow(currentChapterLabel, { chapterWord: t("lawViewer.chapter") }) : null),
    [currentChapterLabel, t]
  );

  const isOverview = selection.selected.kind === "overview";
  const breadcrumb = (derived.hasLoadedContent && derived.currentLawLabel)
    ? {
      lawLabel: derived.currentLawLabel,
      lawRoute: overviewRoute,
      sectionLabel: isOverview ? undefined : (chapterEyebrow || undefined),
    }
    : null;

  // Resume tracking: persist the reader position once per selection change so
  // the library can offer a "Resume at Art. N" deep-link.
  const { articles, recitals, annexes } = primaryDocument.data;
  // Stable identity so consumers keyed on `lists` (e.g. TopBar's search-index
  // reset effect) don't rebuild on every render.
  const lawLists = useMemo(
    () => ({ articles, recitals, annexes }),
    [annexes, articles, recitals]
  );
  useEffect(() => {
    if (!source.effectiveCelex || !derived.hasLoadedContent) return;
    if (primaryDocument.data.celex !== source.effectiveCelex) return;
    const { kind, id } = selection.selected;
    if (kind !== "article" && kind !== "recital" && kind !== "annex") return;
    if (id == null) return;
    const total = kind === "article"
      ? articles?.length || 0
      : kind === "recital"
        ? recitals?.length || 0
        : annexes?.length || 0;
    const title = kind === "article"
      ? articles?.find((article) => article.article_number === String(id))?.article_title || null
      : null;
    markLawOpened(source.effectiveCelex, { kind, id: String(id), total, title });
  }, [
    annexes?.length,
    articles,
    derived.hasLoadedContent,
    primaryDocument.data.celex,
    recitals?.length,
    selection.selected,
    source.effectiveCelex,
  ]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-paper to-white transition-colors duration-500 print:bg-white dark:from-gray-950 dark:to-gray-900">
      <SEO title={derived.seoData.title} description={derived.seoData.description} type="article" />
      <div className="print:hidden">
        <TopBar
          lawKey={source.currentLaw?.slug || slug || key || "import"}
          title={derived.currentLawLabel}
          breadcrumb={breadcrumb}
          lists={lawLists}
          globalLists={allLawsData}
          eurlexUrl={derived.eurlexUrl}
          onPrint={() => printState.setPrintModalOpen(true)}
          showPrint={!derived.isSideBySide}
          onSearchOpen={handleSearchOpen}
          isSearchLoading={isSearchLoading}
          onToggleSidebar={() => preferences.setIsSidebarOpen((current) => !current)}
          isSidebarOpen={preferences.isSidebarOpen}
          onIncreaseFont={() => preferences.setFontScale((scale) => Math.min(scale + 1, 5))}
          onDecreaseFont={() => preferences.setFontScale((scale) => Math.max(scale - 1, 1))}
          fontSize={getFontPercent(preferences.fontScale)}
          formexLang={displayedFormexLang}
          formexLangLocked={derived.isLegacyHtmlFallback}
          formexLanguageExclusions={derived.isLegacyHtmlFallback
            ? Object.keys(EU_LANGUAGES).filter((code) => code !== "EN")
            : []
          }
          searchableLawCount={searchableLawCount}
          onFormexLangChange={preferences.handleUnifiedLanguageChange}
          hasCelex={derived.hasCelex}
          onToggleSecondLanguage={derived.hasCelex && !derived.isLegacyHtmlFallback ? preferences.toggleSecondLanguage : null}
          isSideBySide={derived.isSideBySide}
          searchModes={locale === "en"
            ? ["laws", "matches", "definitions", "fulltext", "current"]
            : ["laws", "matches", "definitions", "current"]}
          defaultSearchMode="current"
          persistenceKey="legalviz-law-reader-search"
        />

        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:flex-row md:gap-6 md:px-6 md:py-6">
          <div className="order-2 mx-auto w-full min-w-0 max-w-4xl flex-1 transition-all duration-300">
            <section className="min-h-[50vh] rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900 md:p-12">
              {derived.activeLoading ? (
                <LawViewerLoadingState message={derived.loadingMessage} t={t} />
              ) : activeLoadError && !derived.hasLoadedContent ? (
                <LawViewerErrorState
                  loadError={activeLoadError}
                  externalFallbackUrl={derived.externalFallbackUrl}
                  retryLoad={source.loadError ? source.retryLoad : primaryDocument.reload}
                  t={t}
                />
              ) : !activeLoadError && !derived.hasLoadedContent ? (
                <LawViewerErrorState
                  loadError={getEmptyContentDetails(t)}
                  externalFallbackUrl={derived.externalFallbackUrl}
                  t={t}
                />
              ) : selection.selected.kind === "overview" ? (
                <LawOverviewPage
                  currentLaw={source.currentLaw}
                  data={primaryDocument.data}
                  effectiveCelex={source.effectiveCelex}
                  formexLang={displayedFormexLang}
                  onArticleClick={interactions.onCrossRefArticle}
                  onStartReading={() => {
                    if (primaryDocument.data.articles?.[0]) selection.selectArticleIdx(0);
                    else if (primaryDocument.data.recitals?.[0]) selection.selectRecitalIdx(0);
                    else if (primaryDocument.data.annexes?.[0]) selection.selectAnnexIdx(0);
                  }}
                  externalLawOverview={derived.externalLawOverview}
                  onOpenExternalLaw={interactions.handleOpenExternalLaw}
                  onOpenCitedLaw={interactions.handleOpenLawByCelex}
                  isExternalReferencePending={interactions.isExternalReferencePending}
                  locale={locale}
                  version={requestedVersion}
                  versionUnavailable={derived.versionUnavailable}
                  versionDate={derived.versionDate}
                  onToggleVersion={setVersion}
                  t={t}
                />
              ) : (
                <>
                  {chapterEyebrow ? (
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-eu-gold-deep dark:text-eu-gold-bright">
                      {chapterEyebrow}
                    </p>
                  ) : null}
                  <div className="mb-4 flex items-center justify-between gap-4">
                    <h2 className="min-w-0 truncate font-serif text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                      {getSelectionTitle(selection.selected, t)}
                    </h2>
                  </div>

                  <ConsolidationNotice
                    celex={source.effectiveCelex}
                    currentLang={displayedFormexLang}
                    locale={locale}
                    variant="inline"
                    source={primaryDocument.data.source}
                    version={requestedVersion}
                    versionUnavailable={derived.versionUnavailable}
                    versionDate={derived.versionDate}
                    onToggleVersion={setVersion}
                  />

                  <ConsolidatedFallbackNotice
                    source={primaryDocument.data.source}
                    consolidatedVersion={derived.consolidatedVersion}
                    version={requestedVersion}
                  />

                  {interactions.isResolvingExternalLaw ? (
                    <div className="mb-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                      <Loader2 size={16} className="animate-spin" />
                      <span>
                        {t("lawViewer.resolvingLinkedLaw", {
                          label: interactions.pendingExternalReferenceLabel || t("lawViewer.resolvingLinkedLawFallback"),
                        })}
                      </span>
                    </div>
                  ) : null}

                  {derived.isLegacyHtmlFallback ? (
                    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
                      <div className="font-medium">{t("lawViewer.legacyHtmlFallbackTitle")}</div>
                      <p className="mt-1 leading-6">
                        {t("lawViewer.legacyHtmlFallbackMessage")}
                      </p>
                    </div>
                  ) : null}

                  <LawViewerSideBySide
                    isSideBySide={derived.isSideBySide}
                    secondaryLang={preferences.secondaryLang}
                    setSecondaryLanguage={preferences.setSecondaryLanguage}
                    hasCelex={derived.hasCelex}
                    formexLang={displayedFormexLang}
                    selected={selection.selected}
                    secondaryLoading={secondaryDocument.loading}
                    secondaryLoadError={secondaryDocument.loadError}
                    secondaryProcessedHtml={secondaryProcessedHtml}
                    processedHtml={processedHtml}
                    handleContentClick={interactions.handleContentClick}
                    getProseClass={getProseClass}
                    getTextClass={getTextClass}
                    fontScale={preferences.fontScale}
                    isResolvingExternalLaw={interactions.isResolvingExternalLaw}
                    onTouchStart={interactions.onTouchStart}
                    onTouchMove={interactions.onTouchMove}
                    onTouchEnd={interactions.onTouchEnd}
                    t={t}
                  />

                  <DefinitionTooltip
                    t={t}
                    onCompareDefinition={displayedFormexLang === "EN" || displayedFormexLang === "ENG"
                      ? openDefinitionComparison
                      : null}
                  />

                  <LawViewerReadingFooter
                    selected={selection.selected}
                    lists={lawLists}
                    onPrevNext={selection.onPrevNext}
                    onGoOverview={goToOverview}
                    t={t}
                  />
                </>
              )}
            </section>

            {selection.selected.kind === "article" ? (
              <div className="xl:hidden">
                <RelatedRecitals
                  recitals={recitalMap.get(selection.selected.id) || []}
                  allRecitals={primaryDocument.data.recitals}
                  recitalTitlesLoading={primaryDocument.recitalTitlesLoading}
                  onSelectRecital={selection.onClickRecital}
                />
                <GeneralRecitals
                  recitalNumbers={recitalMap.orphanRecitalNumbers || []}
                  allRecitals={primaryDocument.data.recitals}
                  recitalTitlesLoading={primaryDocument.recitalTitlesLoading}
                  onSelectRecital={selection.onClickRecital}
                />
                <RelatedCaseLaw
                  celex={source.effectiveCelex}
                  articleNumber={selection.selected.id}
                  currentLang={displayedFormexLang}
                  insertedInVersion={isSelectedArticleInsertedInVersion}
                />
                <CrossReferences
                  articleNumber={selection.selected.id}
                  crossReferences={primaryDocument.data.crossReferences}
                  articles={primaryDocument.data.articles}
                  onSelectArticle={interactions.onCrossRefArticle}
                  currentLang={displayedFormexLang}
                  onOpenExternalReference={interactions.handleOpenExternalLaw}
                  isExternalReferencePending={interactions.isExternalReferencePending}
                />
                <CitedByPanel
                  celex={source.effectiveCelex}
                  articleNumber={selection.selected.id}
                  currentLang={displayedFormexLang}
                  onOpenLaw={interactions.handleOpenLawByCelex}
                  insertedInVersion={isSelectedArticleInsertedInVersion}
                />
              </div>
            ) : null}

            {selection.selected.kind === "annex" ? (
              <CrossReferences
                entryKey={`annex_${selection.selected.id}`}
                crossReferences={primaryDocument.data.crossReferences}
                articles={primaryDocument.data.articles}
                onSelectArticle={interactions.onCrossRefArticle}
                itemLabel="annex"
                showBackReferences={false}
                currentLang={displayedFormexLang}
                onOpenExternalReference={interactions.handleOpenExternalLaw}
                isExternalReferencePending={interactions.isExternalReferencePending}
              />
            ) : null}

            {activeLoadError && derived.hasLoadedContent ? (
              <div className={`mt-4 rounded-2xl border p-4 text-sm ${
                activeLoadError.tone === "notice"
                  ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-200"
                  : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{activeLoadError.message}</span>
                  <Button type="button" variant="outline" size="sm" onClick={source.loadError ? source.retryLoad : primaryDocument.reload}>
                    <RefreshCw size={14} />
                    {t("common.retry")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <LawViewerSidebar
            isSidebarOpen={preferences.isSidebarOpen}
            mobileMenuOpen={selection.mobileMenuOpen}
            selected={selection.selected}
            data={primaryDocument.data}
            onPrevNext={selection.onPrevNext}
            selection={selection}
            loading={derived.activeLoading}
            loadError={activeLoadError}
            hasLoadedContent={derived.hasLoadedContent}
            isOverview={isOverview}
            onGoOverview={goToOverview}
            collapsed={derived.isSideBySide && !isRailExpanded}
            onExpand={() => setIsRailExpanded(true)}
            onCollapse={derived.isSideBySide ? () => setIsRailExpanded(false) : undefined}
            t={t}
          />

          {(selection.selected.kind === "article" || definitionComparison) && derived.hasLoadedContent ? (
            <aside className="order-3 hidden xl:block xl:w-80 xl:shrink-0">
              <div className="xl:sticky xl:top-20">
                <LawViewerContextRail
                  relatedRecitals={recitalMap.get(selection.selected.id) || []}
                  orphanRecitalNumbers={recitalMap.orphanRecitalNumbers || []}
                  allRecitals={primaryDocument.data.recitals}
                  onSelectRecital={selection.onClickRecital}
                  celex={source.effectiveCelex}
                  articleNumber={selection.selected.id}
                  currentLang={displayedFormexLang}
                  crossReferences={primaryDocument.data.crossReferences}
                  articles={primaryDocument.data.articles}
                  onSelectArticle={interactions.onCrossRefArticle}
                  onOpenExternalReference={interactions.handleOpenExternalLaw}
                  isExternalReferencePending={interactions.isExternalReferencePending}
                  onOpenLaw={interactions.handleOpenLawByCelex}
                  definitionComparison={definitionComparison}
                  insertedInVersion={isSelectedArticleInsertedInVersion}
                  t={t}
                />
              </div>
            </aside>
          ) : null}
        </main>
      </div>

      <PrintModal
        isOpen={printState.printModalOpen}
        onClose={() => printState.setPrintModalOpen(false)}
        onPrint={(options) => printState.setPrintOptions(options)}
        counts={{
          articles: primaryDocument.data.articles?.length || 0,
          recitals: primaryDocument.data.recitals?.length || 0,
          annexes: primaryDocument.data.annexes?.length || 0,
        }}
      />
      <DefinitionComparisonSheet
        {...definitionComparison}
        currentCelex={source.effectiveCelex}
        t={t}
      />
    </div>
  );
}
