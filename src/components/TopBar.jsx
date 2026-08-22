import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { Button } from "./Button.jsx";
import { ThemeToggle } from "./ThemeToggle.jsx";
import { LanguageSelector } from "./LanguageSelector.jsx";
import { useI18n } from "../i18n/useI18n.js";
import {
  searchDefinitions as searchDefinitionsApi,
  searchFulltext as searchFulltextApi,
  searchLaws as searchLawsApi,
} from "../utils/formexApi.js";
import { parseCelexQuery } from "../utils/lawRouting.js";
import { inferOfficialReferenceFromCelex } from "../utils/library.js";
import { formatOfficialReference } from "../utils/lawDisplay.js";
import { useSearchNavigation } from "../hooks/useSearchNavigation.js";
import { useNetworkedSearch } from "../hooks/search/useNetworkedSearch.js";
import { useLocalSearchIndexes } from "../hooks/search/useLocalSearchIndexes.js";
import { ToolsMenu } from "./ToolsMenu.jsx";
import { McpTopBarButton } from "./McpPromo.jsx";
import { SearchModal } from "./search/SearchModal.jsx";

// Law search hits the network per query, so wait for a typing pause before
// firing to avoid a request per keystroke (which trips the API rate limiter).
const LAW_SEARCH_DEBOUNCE_MS = 300;

export function SearchBox({
  lists,
  globalLists = null,
  onNavigate,
  onSearchOpen,
  hasSearchInitialized = true,
  isSearchLoading,
  activeLanguage = "EN",
  searchableLawCount = 0,
  triggerVariant = "compact",
  searchModes = null,
  defaultSearchMode = null,
  currentLawLabel = "",
  persistenceKey = null,
}) {
  const { t } = useI18n();
  const effectiveGlobalLists = globalLists || lists;
  const readPersistedState = useCallback(() => {
    if (!persistenceKey || typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(persistenceKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, [persistenceKey]);
  const availableModes = useMemo(() => {
    if (Array.isArray(searchModes) && searchModes.length > 0) {
      return searchModes;
    }
    return typeof onSearchOpen === "function" ? ["laws", "matches", "definitions"] : ["current"];
  }, [onSearchOpen, searchModes]);
  const persistedState = useMemo(() => readPersistedState(), [readPersistedState]);
  const [query, setQuery] = useState(() => String(persistedState?.query || ""));
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [searchMode, setSearchMode] = useState(() => (
    persistedState?.searchMode && availableModes.includes(persistedState.searchMode)
      ? persistedState.searchMode
      : defaultSearchMode && availableModes.includes(defaultSearchMode)
        ? defaultSearchMode
      : availableModes[0]
  ));
  const [definitionDiscoveryFilter, setDefinitionDiscoveryFilter] = useState("");
  const [isSmallViewport, setIsSmallViewport] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(max-width: 639px)").matches;
  });

  const containerRef = useRef(null);
  const heroInputRef = useRef(null);
  const pendingSearchRef = useRef(null);

  const handleSearchResults = useCallback((nextResults) => {
    setResults(nextResults);
    setSelectedIndex(-1);
  }, []);

  const handleLawSearchError = useCallback(() => {
    setResults([]);
  }, []);

  const handleDefinitionSearchError = useCallback((error) => {
    console.error("Failed to search definitions", error);
    setResults([]);
  }, []);

  const handleFulltextSearchError = useCallback((error) => {
    console.error("Failed to search full text", error);
    setResults([]);
  }, []);

  const handleDefinitionSearchReset = useCallback(() => {
    setDefinitionDiscoveryFilter("");
  }, []);

  const runLawSearch = useCallback(async (query, { signal }) => {
    const celexQuery = parseCelexQuery(query);
    // Derive a stable title from the CELEX (e.g. "Regulation (EU) 2016/679") so
    // the result — and the library label saved on navigation — is meaningful
    // rather than empty when no backend record supplies a real title.
    const celexTitle = celexQuery
      ? formatOfficialReference(inferOfficialReferenceFromCelex(celexQuery)) || ""
      : "";
    const buildCelexResult = () => ({
      celex: celexQuery,
      title: celexTitle,
      search_kind: "law",
      id: celexQuery,
      directCelex: true,
    });
    // A pasted EUR-Lex URL (or "CELEX:"-prefixed id) identifies exactly one act,
    // but the backend anchors its CELEX regex at the start of the query, so it
    // never extracts the id from the surrounding URL text and falls back to a
    // fuzzy token search — leaving the target buried among unrelated hits. When
    // we've already resolved the CELEX client-side, query the backend by that
    // canonical id so it returns the act as the deterministic top result.
    const backendQuery = celexQuery || query;
    try {
      const payload = await searchLawsApi(backendQuery, { limit: 12, signal });
      const nextResults = Array.isArray(payload?.results)
        ? payload.results.map((item) => ({
          ...item,
          search_kind: "law",
          id: item.celex,
        }))
        : [];
      const hasCelexExact = celexQuery
        && nextResults.some((item) => String(item.celex || "").toUpperCase() === celexQuery);
      return celexQuery && !hasCelexExact ? [buildCelexResult(), ...nextResults] : nextResults;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.error("Failed to search laws", error);
      // Even if the backend search fails, a valid CELEX can still be opened.
      if (celexQuery) return [buildCelexResult()];
      throw error;
    }
  }, []);

  const runDefinitionSearch = useCallback(async (query, { signal, filter = "" }) => {
    setDefinitionDiscoveryFilter(filter);
    const payload = await searchDefinitionsApi(query, { limit: 12, filter, signal });
    return Array.isArray(payload?.results)
      ? payload.results.map((item, index) => ({
        ...item,
        search_kind: "definition",
        id: item.normalizedTerm || item.term || index,
      }))
      : [];
  }, []);

  const runFulltextSearch = useCallback(async (query, { signal }) => {
    const payload = await searchFulltextApi(query, { limit: 12, signal });
    const sourceResults = Array.isArray(payload) ? payload : payload?.results;
    return Array.isArray(sourceResults)
      ? sourceResults.map((item, index) => {
        // A stable key must not contain an accidental `undefined`: the
        // backend contract normally supplies all three parts, but keeping
        // a deterministic fallback avoids React key collisions on a bad row.
        const celex = String(item?.celex || "unknown-celex").toUpperCase();
        const unitType = String(item?.unitType || "unit").toLowerCase();
        const number = item?.number == null || item.number === ""
          ? "unnumbered"
          : String(item.number);
        return {
          ...item,
          search_kind: "fulltext",
          id: `${celex}:${unitType}:${number}:${index}`,
        };
      })
      : [];
  }, []);

  const lawSearch = useNetworkedSearch({
    minQueryLength: 2,
    debounceMs: LAW_SEARCH_DEBOUNCE_MS,
    run: runLawSearch,
    onResults: handleSearchResults,
    onError: handleLawSearchError,
    invalidateOnReset: true,
  });

  const definitionSearch = useNetworkedSearch({
    minQueryLength: 2,
    debounceMs: LAW_SEARCH_DEBOUNCE_MS,
    run: runDefinitionSearch,
    onResults: handleSearchResults,
    onError: handleDefinitionSearchError,
    onReset: handleDefinitionSearchReset,
    invalidateOnReset: false,
  });

  const fulltextSearch = useNetworkedSearch({
    minQueryLength: 2,
    debounceMs: LAW_SEARCH_DEBOUNCE_MS,
    run: runFulltextSearch,
    onResults: handleSearchResults,
    onError: handleFulltextSearchError,
    abortOnSchedule: true,
    invalidateOnReset: false,
  });

  const {
    schedule: scheduleLawSearch,
    execute: executeLawSearch,
    abort: abortLawSearch,
    clearError: clearLawSearchError,
  } = lawSearch;
  const {
    schedule: scheduleDefinitionSearch,
    execute: executeDefinitionSearch,
    abort: abortDefinitionSearch,
    reset: resetDefinitionSearch,
    clearError: clearDefinitionSearchError,
  } = definitionSearch;
  const {
    schedule: scheduleFulltextSearch,
    abort: abortFulltextSearch,
    reset: resetFulltextSearch,
    clearError: clearFulltextSearchError,
  } = fulltextSearch;
  const hasGlobalSearch = availableModes.includes("laws")
    || availableModes.includes("matches")
    || availableModes.includes("definitions")
    || availableModes.includes("fulltext");
  const globalEntryCount = (effectiveGlobalLists?.articles?.length || 0)
    + (effectiveGlobalLists?.recitals?.length || 0)
    + (effectiveGlobalLists?.annexes?.length || 0);
  const isCurrentMode = searchMode === "current";
  const isLawMode = searchMode === "laws";
  const isMatchesMode = searchMode === "matches";
  const isDefinitionsMode = searchMode === "definitions";
  const isFulltextMode = searchMode === "fulltext";
  const isCurrentBusy = isCurrentMode && isBuildingCurrent;
  const isMatchesBusy = isMatchesMode && (isBuildingGlobal || isSearchLoading);
  const isBusy = isLawMode
    ? lawSearch.isLoading
    : isDefinitionsMode
      ? definitionSearch.isLoading
      : isFulltextMode
        ? fulltextSearch.isLoading
        : isCurrentBusy || isMatchesBusy;

  const localIndexes = useLocalSearchIndexes({
    lists,
    globalLists: effectiveGlobalLists,
    query,
    isOpen,
    searchMode,
    isSearchLoading,
    onSearchOpen,
    globalEntryCount,
    searchableLawCount,
    hasSearchInitialized,
    setResults,
    pendingSearchRef,
  });
  const {
    isBuildingCurrent,
    isBuildingGlobal,
    runCurrentSearch,
    runGlobalMatchSearch,
  } = localIndexes;

  useEffect(() => {
    if (!availableModes.includes(searchMode)) {
      setSearchMode(
        persistedState?.searchMode && availableModes.includes(persistedState.searchMode)
          ? persistedState.searchMode
          : defaultSearchMode && availableModes.includes(defaultSearchMode)
            ? defaultSearchMode
          : availableModes[0]
      );
    }
  }, [availableModes, defaultSearchMode, persistedState?.searchMode, searchMode]);

  useEffect(() => {
    if (!persistenceKey || typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(persistenceKey, JSON.stringify({
        query,
        searchMode,
      }));
    } catch {
      // ignore persistence failures
    }
  }, [persistenceKey, query, searchMode]);

  const executeSearch = useCallback((mode, nextQuery) => {
    if (mode === "laws") {
      pendingSearchRef.current = null;
      scheduleLawSearch(nextQuery);
      return;
    }

    if (mode === "current") {
      if (isBuildingCurrent) {
        pendingSearchRef.current = { mode, query: nextQuery };
        return;
      }
      pendingSearchRef.current = null;
      runCurrentSearch(nextQuery);
      return;
    }

    if (mode === "definitions") {
      pendingSearchRef.current = null;
      scheduleDefinitionSearch(nextQuery);
      return;
    }

    if (mode === "fulltext") {
      pendingSearchRef.current = null;
      scheduleFulltextSearch(nextQuery);
      return;
    }

    if (mode === "matches") {
      if (!hasSearchInitialized && typeof onSearchOpen === "function") {
        pendingSearchRef.current = { mode, query: nextQuery };
        Promise.resolve(onSearchOpen())
          .then((loadedLists) => {
            const pending = pendingSearchRef.current;
            if (!pending || pending.mode !== "matches" || pending.query !== nextQuery) return;
            pendingSearchRef.current = null;
            runGlobalMatchSearch(pending.query, loadedLists, null);
          })
          .catch((error) => {
            console.error("Failed to initialize within-laws search", error);
          });
        return;
      }

      if (
        isSearchLoading
        || isBuildingGlobal
        || (typeof onSearchOpen === "function" && globalEntryCount === 0 && searchableLawCount > 0)
      ) {
        pendingSearchRef.current = { mode, query: nextQuery };
        if (typeof onSearchOpen === "function") {
          void onSearchOpen();
        }
        return;
      }
      pendingSearchRef.current = null;
      runGlobalMatchSearch(nextQuery);
    }
  }, [
    globalEntryCount,
    hasSearchInitialized,
    isBuildingCurrent,
    isBuildingGlobal,
    isSearchLoading,
    onSearchOpen,
    runCurrentSearch,
    runGlobalMatchSearch,
    scheduleLawSearch,
    scheduleDefinitionSearch,
    scheduleFulltextSearch,
    searchableLawCount,
  ]);

  // Trigger search data loading on open
  useEffect(() => {
    if (isOpen && isMatchesMode) {
      onSearchOpen?.();
    }
  }, [isMatchesMode, isOpen, onSearchOpen]);

  // Reset results when source data changes
  useEffect(() => {
    setResults([]);
    clearLawSearchError();
    clearDefinitionSearchError();
    clearFulltextSearchError();
  }, [clearLawSearchError, clearDefinitionSearchError, clearFulltextSearchError, lists]);

  useEffect(() => {
    setResults([]);
    clearLawSearchError();
    clearDefinitionSearchError();
    clearFulltextSearchError();
  }, [clearLawSearchError, clearDefinitionSearchError, clearFulltextSearchError, effectiveGlobalLists]);

  useEffect(() => () => {
    abortLawSearch();
    abortDefinitionSearch();
    abortFulltextSearch();
  }, [abortLawSearch, abortDefinitionSearch, abortFulltextSearch]);

  // Prevent a delayed response from the mode the user just left replacing
  // the results for the newly selected mode.
  useEffect(() => {
    if (!isLawMode) abortLawSearch();
    if (!isDefinitionsMode) abortDefinitionSearch();
    if (!isFulltextMode) abortFulltextSearch();
  }, [isDefinitionsMode, isFulltextMode, isLawMode, abortLawSearch, abortDefinitionSearch, abortFulltextSearch]);

  // Closing the spotlight is also a full-text search boundary: there is no
  // visible consumer left for a pending response, so cancel it immediately.
  useEffect(() => {
    if (isOpen || !isFulltextMode) return;
    abortFulltextSearch();
  }, [isFulltextMode, isOpen, abortFulltextSearch]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    const mediaQuery = window.matchMedia("(max-width: 639px)");
    const handleChange = (event) => {
      setIsSmallViewport(event.matches);
    };

    setIsSmallViewport(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const handleSelect = useCallback((item) => {
    Promise.resolve(onNavigate(item));
    // setQuery(""); // Keep search term
    // setResults([]); // Keep results
    setIsOpen(false);
  }, [onNavigate]);

  const handleSearch = (e) => {
    const q = e.target.value;
    setQuery(q);
    setSelectedIndex(-1);
    clearLawSearchError();
    clearDefinitionSearchError();
    clearFulltextSearchError();

    if (!isOpen && triggerVariant === "hero") {
      if (q.trim().length === 0) {
        setResults([]);
        return;
      }
      setIsOpen(true);
    }

    if ((isLawMode && q.trim() !== lawSearch.lastQuery)
      || (isDefinitionsMode && q.trim() !== definitionSearch.lastQuery)
      || (isFulltextMode && q.trim() !== fulltextSearch.lastQuery)) {
      setResults([]);
      return;
    }
    // current/matches run through the hook's query-change effect once their
    // index is ready; executing here too would run the search twice per
    // keystroke.
    if (isCurrentMode || isMatchesMode) return;
    executeSearch(searchMode, q);
  };

  useEffect(() => {
    if (!isOpen) return;
    // current/matches are driven by the local-index hook's query-change
    // effect; this orchestrator handles only the networked modes.
    if (isCurrentMode || isMatchesMode) return;
    setSelectedIndex(-1);
    setResults([]);
    clearLawSearchError();
    clearDefinitionSearchError();
    clearFulltextSearchError();
    if (isLawMode) {
      scheduleLawSearch(query);
      return;
    }
    executeSearch(searchMode, query);
  }, [executeSearch, isCurrentMode, isLawMode, isMatchesMode, isOpen, query, scheduleLawSearch, clearLawSearchError, clearDefinitionSearchError, clearFulltextSearchError, searchMode]);

  const heroSearchPlaceholder = isSmallViewport
    ? t("landing.searchPlaceholderMobile")
    : t("landing.searchPlaceholder");
  const isInputDisabled = isCurrentMode
    ? isBuildingCurrent
    : isMatchesMode
      ? (isBuildingGlobal || isSearchLoading)
      : false;

  const handleOpenSearch = useCallback(() => setIsOpen(true), []);
  const handleCloseSearch = useCallback(() => setIsOpen(false), []);

  const handleClearErrors = useCallback(() => {
    clearLawSearchError();
    clearDefinitionSearchError();
    clearFulltextSearchError();
  }, [clearLawSearchError, clearDefinitionSearchError, clearFulltextSearchError]);

  const handleClear = useCallback(() => {
    setQuery("");
    setResults([]);
    setDefinitionDiscoveryFilter("");
    resetFulltextSearch();
  }, [resetFulltextSearch]);

  const handleDefinitionDiscovery = useCallback((id) => {
    setQuery("");
    if (id) {
      executeDefinitionSearch("", { filter: id });
    } else {
      resetDefinitionSearch();
      setDefinitionDiscoveryFilter("");
    }
  }, [executeDefinitionSearch, resetDefinitionSearch]);

  return (
    <>
      <div className="relative transition-all" ref={containerRef}>
        {triggerVariant === "hero" ? (
          <div
            className="group flex w-full items-center gap-3 rounded-[1.75rem] border border-gray-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-gray-300 hover:shadow-md focus-within:border-gray-300 focus-within:shadow-md sm:gap-4 sm:rounded-full sm:px-5 sm:py-4 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700 dark:focus-within:border-gray-700"
            onClick={() => heroInputRef.current?.focus()}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition group-hover:bg-gray-200 group-hover:text-gray-700 sm:h-11 sm:w-11 dark:bg-gray-800 dark:text-gray-400 dark:group-hover:bg-gray-700 dark:group-hover:text-gray-200">
              <Search size={18} className="sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <input
                ref={heroInputRef}
                type="text"
                value={query}
                onChange={handleSearch}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isOpen && query.trim().length >= 2) {
                    e.preventDefault();
                    setIsOpen(true);
                  }
                }}
                placeholder={heroSearchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-500 sm:text-base dark:text-gray-200 dark:placeholder:text-gray-400"
                aria-label={heroSearchPlaceholder}
              />
            </div>
            <div className="hidden shrink-0 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-500 sm:block dark:border-gray-700 dark:text-gray-400">
              {t("search.shortcut")}
            </div>
          </div>
        ) : (
          <div className="relative lg:w-64">
            <div className="relative hidden w-full lg:block">
              <input
                type="text"
                readOnly
                onClick={() => setIsOpen(true)}
                placeholder={t("search.trigger")}
                className="w-full cursor-pointer rounded-xl border border-gray-200 bg-gray-50 py-1.5 pl-9 pr-4 text-sm outline-none transition-all hover:border-blue-300 hover:bg-white focus:ring-0 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:placeholder:text-gray-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
            </div>

            <div className="lg:hidden">
              <button
                type="button"
                onClick={() => setIsOpen(true)}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              >
                <Search size={20} />
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Spotlight Modal Overlay (Rendered in Portal to cover whole screen) */}
      <SearchModal
        isOpen={isOpen}
        onOpen={handleOpenSearch}
        onClose={handleCloseSearch}
        query={query}
        onQueryChange={handleSearch}
        onClear={handleClear}
        results={results}
        selectedIndex={selectedIndex}
        onSelectedIndexChange={setSelectedIndex}
        onSelect={handleSelect}
        searchMode={searchMode}
        onSearchModeChange={setSearchMode}
        onClearErrors={handleClearErrors}
        availableModes={availableModes}
        onExecuteLawSearch={executeLawSearch}
        definitionDiscoveryFilter={definitionDiscoveryFilter}
        onDefinitionDiscovery={handleDefinitionDiscovery}
        isBusy={isBusy}
        isInputDisabled={isInputDisabled}
        hasGlobalSearch={hasGlobalSearch}
        lawError={lawSearch.error}
        definitionError={definitionSearch.error}
        fulltextError={fulltextSearch.error}
        searchableLawCount={searchableLawCount}
        activeLanguage={activeLanguage}
        currentLawLabel={currentLawLabel}
        lawLastQuery={lawSearch.lastQuery}
        definitionLastQuery={definitionSearch.lastQuery}
        fulltextLastQuery={fulltextSearch.lastQuery}
      />
    </>
  );
}

export function TopBar({
  lawKey,
  title,
  breadcrumb = null,
  lists,
  globalLists = null,
  eurlexUrl,
  onPrint,
  showPrint = true,
  onSearchOpen,
  hasSearchInitialized = true,
  isSearchLoading,
  onToggleSidebar,
  isSidebarOpen,
  onIncreaseFont,
  onDecreaseFont,
  fontSize,
  formexLang,
  searchableLawCount = 0,
  onFormexLangChange,
  formexLangLocked = false,
  formexLanguageExclusions = [],
  hasCelex,
  onToggleSecondLanguage,
  isSideBySide = false,
  onResetApp,
  showSearch = true,
  searchModes = null,
  defaultSearchMode = null,
}) {
  const navigate = useNavigate();
  const { locale, localizePath, t } = useI18n();

  const onNavigate = useSearchNavigation(lawKey);

  return (
    <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/95 backdrop-blur-sm supports-[backdrop-filter]:bg-white/80 dark:bg-gray-900/95 dark:supports-[backdrop-filter]:bg-gray-900/80 dark:border-gray-800">
      <div className="relative mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 md:px-6">
        {/* Left: Branding */}
        <div className="flex-shrink-0 flex items-center gap-3">
          <button
            onClick={() => navigate(localizePath("/", locale))}
            className="flex items-center justify-center transition-opacity hover:opacity-80"
          >
            <img
              src={`${import.meta.env.BASE_URL}wizard.png`}
              alt={t("app.name")}
              className="h-10 w-auto dark:invert dark:hue-rotate-180"
            />
          </button>
          <div className="hidden md:flex flex-col">
            <button
              onClick={() => navigate(localizePath("/", locale))}
              className="text-left font-display text-lg font-bold tracking-tight text-eu-navy leading-none transition-opacity hover:opacity-80 dark:text-white"
            >
              {t("app.name")}
            </button>
            <span className="text-[10px] text-gray-500 leading-tight mt-0.5">
              {"By "}
              <a
                href="https://kollnig.net"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                Konrad Kollnig
              </a>
              {", "}
              <a
                href="https://www.maastrichtuniversity.nl/law-tech-lab"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                Law &amp; Tech Lab Maastricht
              </a>
            </span>
          </div>
        </div>

        {/* Center: Title or breadcrumb */}
        <div className="flex-1 min-w-0 flex items-center justify-center">
          {breadcrumb ? (
            <div className="flex items-center gap-1.5 min-w-0 max-w-full truncate text-sm">
              <Link
                to={breadcrumb.lawRoute}
                className="truncate font-medium text-eu-blue transition-opacity hover:opacity-80 dark:text-eu-blue-bright"
                title={breadcrumb.lawLabel}
              >
                {breadcrumb.lawLabel}
              </Link>
              {breadcrumb.sectionLabel ? (
                <span className="hidden truncate text-gray-400 md:inline dark:text-gray-500" title={breadcrumb.sectionLabel}>
                  {" / "}
                  {breadcrumb.sectionLabel}
                </span>
              ) : null}
            </div>
          ) : title ? (
            <div className="flex items-center gap-2 min-w-0 max-w-full">
              <span
                className="line-clamp-2 text-sm font-medium text-gray-700 dark:text-gray-300 text-center"
                title={title}
              >
                {title}
              </span>
            </div>
          ) : null}
        </div>

        {/* Right: Navigation Controls */}
        <div className="flex-shrink-0 flex items-center gap-2 md:gap-3">
          <LanguageSelector
            currentLang={formexLang}
            onChangeLang={onFormexLangChange}
            hasCelex={hasCelex}
            disabled={formexLangLocked}
            excludeLanguages={formexLanguageExclusions}
          />

          <McpTopBarButton />

          <div className="relative flex items-center">
            <ToolsMenu
              onPrint={onPrint}
              showPrint={showPrint}
              onIncreaseFont={onIncreaseFont}
              onDecreaseFont={onDecreaseFont}
              fontSize={fontSize}
              eurlexUrl={eurlexUrl}
              onToggleSidebar={onToggleSidebar}
              isSidebarOpen={isSidebarOpen}
              onToggleSecondLanguage={onToggleSecondLanguage}
              isSideBySide={isSideBySide}
              onResetApp={onResetApp}
            />
          </div>

          {showSearch ? (
            <SearchBox
              lists={lists}
              globalLists={globalLists}
              onNavigate={onNavigate}
              onSearchOpen={onSearchOpen}
              hasSearchInitialized={hasSearchInitialized}
              isSearchLoading={isSearchLoading}
              activeLanguage={formexLang}
              searchableLawCount={searchableLawCount}
              searchModes={searchModes}
              defaultSearchMode={defaultSearchMode}
              currentLawLabel={title}
            />
          ) : null}

        </div>
      </div>
    </header>
  );
}
