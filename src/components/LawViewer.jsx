import React, { useEffect, useMemo, useState } from "react";
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
import { EU_LANGUAGES } from "../utils/formexApi.js";
import {
  ARTICLE_NAVIGATION_HINT_DISMISSED_KEY,
  shouldShowArticleNavigationHint,
} from "../utils/law-viewer/navigationHint.js";
import { LawViewerLoadingState } from "./law-viewer/LawViewerLoadingState.jsx";
import { LawViewerErrorState } from "./law-viewer/LawViewerErrorState.jsx";
import { LawViewerSidebar } from "./law-viewer/LawViewerSidebar.jsx";
import { LawViewerSideBySide } from "./law-viewer/LawViewerSideBySide.jsx";

export function LawViewer() {
  const { locale: routeLocale, slug, key, kind, id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { locale, setLocale, localizePath, t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const importCelex = searchParams.get("celex");
  const sourceUrl = searchParams.get("sourceUrl");
  const { allLaws, libraryVersion } = useLandingLibrary();
  const [isArticleNavigationHintDismissed, setIsArticleNavigationHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(ARTICLE_NAVIGATION_HINT_DISMISSED_KEY) === "true";
    } catch {
      return false;
    }
  });

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
  });
  const secondaryDocument = useSecondaryLawDocument({
    celex: source.effectiveCelex,
    secondaryLang: preferences.secondaryLang,
    t,
  });
  const selection = useLawSelection({
    data: primaryDocument.data,
    kind,
    id,
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
    formexLang: preferences.formexLang,
  });
  const primarySelectedEntry = useMemo(
    () => getSelectedEntry(primaryDocument.data, selection.selected),
    [primaryDocument.data, selection.selected]
  );
  const processedHtml = useProcessedLawHtml({
    data: primaryDocument.data,
    selected: selection.selected,
    selectedEntry: primarySelectedEntry,
  });
  const showArticleNavigationHint = shouldShowArticleNavigationHint({
    selected: selection.selected,
    articleCount: primaryDocument.data.articles?.length || 0,
    isDismissed: isArticleNavigationHintDismissed,
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
    hasSearchInitialized,
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

  useEffect(() => {
    if (!derived.isLegacyHtmlFallback || !preferences.secondaryLang) return;
    preferences.setSecondaryLanguage(null);
  }, [
    derived.isLegacyHtmlFallback,
    preferences.secondaryLang,
    preferences.setSecondaryLanguage,
  ]);

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

  useEffect(() => {
    if (!isArticleNavigationHintDismissed) return;
    try {
      localStorage.setItem(ARTICLE_NAVIGATION_HINT_DISMISSED_KEY, "true");
    } catch {
      // ignore localStorage failures
    }
  }, [isArticleNavigationHintDismissed]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white transition-colors duration-500 print:bg-white dark:from-gray-950 dark:to-gray-900">
      <SEO title={derived.seoData.title} description={derived.seoData.description} type="article" />
      <div className="print:hidden">
        <TopBar
          lawKey={source.currentLaw?.slug || slug || key || "import"}
          title={derived.currentLawLabel}
          lists={{ articles: primaryDocument.data.articles, recitals: primaryDocument.data.recitals, annexes: primaryDocument.data.annexes }}
          globalLists={allLawsData}
          isExtensionMode={false}
          eurlexUrl={derived.eurlexUrl}
          onPrint={() => printState.setPrintModalOpen(true)}
          showPrint={!derived.isSideBySide}
          onSearchOpen={handleSearchOpen}
          hasSearchInitialized={hasSearchInitialized}
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
          searchModes={["laws", "matches", "current"]}
          defaultSearchMode="current"
          persistenceKey="legalviz-law-reader-search"
        />

        <main className="mx-auto flex w-full max-w-[1600px] flex-col justify-center gap-4 px-4 py-4 md:flex-row md:gap-6 md:px-6 md:py-6">
          <div className="order-2 w-full min-w-0 max-w-4xl md:order-1 transition-all duration-300">
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
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between gap-4">
                    <h2 className="min-w-0 truncate font-serif text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                      {getSelectionTitle(selection.selected, t)}
                    </h2>
                  </div>

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

                  {showArticleNavigationHint ? (
                    <div className="mt-4 hidden items-start justify-between gap-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200 md:flex">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-sky-200 bg-white/90 px-1.5 text-xs font-semibold text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100">←</span>
                          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-sky-200 bg-white/90 px-1.5 text-xs font-semibold text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100">→</span>
                        </div>
                        <p className="leading-6">{t("lawViewer.articleNavigationHint")}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsArticleNavigationHintDismissed(true)}
                        className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-100 hover:text-sky-900 dark:text-sky-300 dark:hover:bg-sky-900/40 dark:hover:text-sky-100"
                      >
                        {t("common.dismiss")}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </section>

            {selection.selected.kind === "article" ? (
              <>
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
              </>
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
            externalLawOverview={derived.externalLawOverview}
            handleOpenExternalLaw={interactions.handleOpenExternalLaw}
            isExternalReferencePending={interactions.isExternalReferencePending}
            effectiveCelex={source.effectiveCelex}
            formexLang={displayedFormexLang}
            lawTitle={primaryDocument.data.title || primaryDocument.data.doc_title}
            onAskArticleClick={(n) => interactions.onCrossRefArticle?.(n)}
            t={t}
          />
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
    </div>
  );
}
