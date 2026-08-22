import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Search, X, Loader2 } from "lucide-react";
import { Button } from "./Button.jsx";
import { ThemeToggle } from "./ThemeToggle.jsx";
import { LanguageSelector } from "./LanguageSelector.jsx";
import { searchContent, searchIndex as searchWithIndex, buildSearchIndex } from "../utils/nlp.js";
import { useI18n } from "../i18n/useI18n.js";
import {
  searchDefinitions as searchDefinitionsApi,
  searchFulltext as searchFulltextApi,
  searchLaws as searchLawsApi,
} from "../utils/formexApi.js";
import { parseCelexQuery } from "../utils/lawRouting.js";
import { inferOfficialReferenceFromCelex } from "../utils/library.js";
import { useSearchNavigation } from "../hooks/useSearchNavigation.js";
import { ToolsMenu } from "./ToolsMenu.jsx";
import { cleanLawTitle, extractShortLawTitle, formatOfficialReference } from "../utils/lawDisplay.js";
import { lawStatus } from "../utils/lawStatus.js";
import { DefinitionSearchResult } from "./search/DefinitionSearchResult.jsx";
import { FulltextSearchResult } from "./search/FulltextSearchResult.jsx";
import { McpTopBarButton } from "./McpPromo.jsx";

// Law search hits the network per query, so wait for a typing pause before
// firing to avoid a request per keystroke (which trips the API rate limiter).
const LAW_SEARCH_DEBOUNCE_MS = 300;

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
  const [currentSearchIndex, setCurrentSearchIndex] = useState(null);
  const [globalSearchIndex, setGlobalSearchIndex] = useState(null);
  const [isBuildingCurrent, setIsBuildingCurrent] = useState(false);
  const [isBuildingGlobal, setIsBuildingGlobal] = useState(false);
  const [searchMode, setSearchMode] = useState(() => (
    persistedState?.searchMode && availableModes.includes(persistedState.searchMode)
      ? persistedState.searchMode
      : defaultSearchMode && availableModes.includes(defaultSearchMode)
        ? defaultSearchMode
      : availableModes[0]
  ));
  const [isLawSearchLoading, setIsLawSearchLoading] = useState(false);
  const [lawSearchError, setLawSearchError] = useState("");
  const [lastLawSearchQuery, setLastLawSearchQuery] = useState("");
  const [isDefinitionSearchLoading, setIsDefinitionSearchLoading] = useState(false);
  const [lastDefinitionSearchQuery, setLastDefinitionSearchQuery] = useState("");
  const [definitionDiscoveryFilter, setDefinitionDiscoveryFilter] = useState("");
  const [isFulltextSearchLoading, setIsFulltextSearchLoading] = useState(false);
  const [fulltextSearchError, setFulltextSearchError] = useState(null);
  const [lastFulltextSearchQuery, setLastFulltextSearchQuery] = useState("");
  const [isSmallViewport, setIsSmallViewport] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(max-width: 639px)").matches;
  });

  const containerRef = useRef(null);
  const heroInputRef = useRef(null);
  const modalInputRef = useRef(null);
  const resultsRef = useRef(null);
  const lawSearchAbortRef = useRef(null);
  const lawSearchRequestIdRef = useRef(0);
  const lawSearchDebounceRef = useRef(null);
  const definitionSearchAbortRef = useRef(null);
  const definitionSearchDebounceRef = useRef(null);
  const fulltextSearchAbortRef = useRef(null);
  const fulltextSearchDebounceRef = useRef(null);
  const pendingSearchRef = useRef(null);
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
    ? isLawSearchLoading
    : isDefinitionsMode
      ? isDefinitionSearchLoading
      : isFulltextMode
        ? isFulltextSearchLoading
        : isCurrentBusy || isMatchesBusy;

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

  const focusModalInput = useCallback(() => {
    if (!isOpen) return;

    window.requestAnimationFrame(() => {
      const input = modalInputRef.current;
      if (!input) return;
      input.focus();
      const length = input.value.length;
      input.setSelectionRange(length, length);
    });
  }, [isOpen]);

  const runCurrentSearch = useCallback((nextQuery) => {
    if (nextQuery.length < 2) {
      setResults([]);
      return;
    }

    const nextResults = currentSearchIndex
      ? searchWithIndex(nextQuery, currentSearchIndex)
      : searchContent(nextQuery, lists);
    setResults(nextResults);
  }, [currentSearchIndex, lists]);

  const runGlobalMatchSearch = useCallback((nextQuery, sourceLists = effectiveGlobalLists, sourceIndex = globalSearchIndex) => {
    if (nextQuery.length < 2) {
      setResults([]);
      return;
    }

    const nextResults = sourceIndex
      ? searchWithIndex(nextQuery, sourceIndex)
      : searchContent(nextQuery, sourceLists || { articles: [], recitals: [], annexes: [] });
    setResults(nextResults);
  }, [effectiveGlobalLists, globalSearchIndex]);

  const runLawSearch = useCallback((nextQuery) => {
    const trimmedQuery = String(nextQuery || "").trim();
    const requestId = lawSearchRequestIdRef.current + 1;
    lawSearchRequestIdRef.current = requestId;

    if (lawSearchAbortRef.current) {
      lawSearchAbortRef.current.abort();
    }

    setLawSearchError("");

    if (trimmedQuery.length < 2) {
      setResults([]);
      setLastLawSearchQuery("");
      setIsLawSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    lawSearchAbortRef.current = controller;
    setIsLawSearchLoading(true);
    setLastLawSearchQuery(trimmedQuery);

    // A typed CELEX can be opened directly regardless of the search index, so
    // surface it as a result even when the backend finds no (or no exact) match.
    const celexQuery = parseCelexQuery(trimmedQuery);
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
    const backendQuery = celexQuery || trimmedQuery;

    searchLawsApi(backendQuery, { limit: 12, signal: controller.signal })
      .then((payload) => {
        if (lawSearchRequestIdRef.current !== requestId) return;
        const nextResults = Array.isArray(payload?.results)
          ? payload.results.map((item) => ({
            ...item,
            search_kind: "law",
            id: item.celex,
          }))
          : [];
        const hasCelexExact = celexQuery
          && nextResults.some((item) => String(item.celex || "").toUpperCase() === celexQuery);
        setResults(celexQuery && !hasCelexExact ? [buildCelexResult(), ...nextResults] : nextResults);
        setSelectedIndex(-1);
      })
      .catch((error) => {
        if (error?.name === "AbortError" || lawSearchRequestIdRef.current !== requestId) return;
        console.error("Failed to search laws", error);
        // Even if the index lookup fails, a valid CELEX can still be opened.
        if (celexQuery) {
          setResults([buildCelexResult()]);
          setSelectedIndex(-1);
          return;
        }
        setResults([]);
        setLawSearchError(error?.message || t("search.apiUnavailable"));
      })
      .finally(() => {
        if (lawSearchAbortRef.current === controller) {
          lawSearchAbortRef.current = null;
          setIsLawSearchLoading(false);
        }
      });
  }, [t]);

  // Debounced entry point for law search: clears any pending timer and only
  // fires the network request once the user pauses typing.
  const scheduleLawSearch = useCallback((nextQuery) => {
    if (lawSearchDebounceRef.current) {
      clearTimeout(lawSearchDebounceRef.current);
      lawSearchDebounceRef.current = null;
    }

    // Empty/too-short queries reset immediately — no request, no spinner.
    if (String(nextQuery || "").trim().length < 2) {
      runLawSearch(nextQuery);
      return;
    }

    // Show the loading state right away so typing feels responsive, but hold
    // the actual request until the pause elapses.
    setIsLawSearchLoading(true);
    lawSearchDebounceRef.current = setTimeout(() => {
      lawSearchDebounceRef.current = null;
      runLawSearch(nextQuery);
    }, LAW_SEARCH_DEBOUNCE_MS);
  }, [runLawSearch]);

  const runDefinitionSearch = useCallback((nextQuery, discoveryFilter = "") => {
    const trimmedQuery = String(nextQuery || "").trim();
    definitionSearchAbortRef.current?.abort();
    setLawSearchError("");
    setDefinitionDiscoveryFilter(discoveryFilter);

    if (trimmedQuery.length < 2 && !discoveryFilter) {
      setResults([]);
      setLastDefinitionSearchQuery("");
      setIsDefinitionSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    definitionSearchAbortRef.current = controller;
    setIsDefinitionSearchLoading(true);
    setLastDefinitionSearchQuery(trimmedQuery);

    searchDefinitionsApi(trimmedQuery, { limit: 12, filter: discoveryFilter, signal: controller.signal })
      .then((payload) => {
        const nextResults = Array.isArray(payload?.results)
          ? payload.results.map((item, index) => ({
            ...item,
            search_kind: "definition",
            id: item.normalizedTerm || item.term || index,
          }))
          : [];
        setResults(nextResults);
        setSelectedIndex(-1);
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        console.error("Failed to search definitions", error);
        setResults([]);
        setLawSearchError(error?.message || t("search.definitionApiUnavailable"));
      })
      .finally(() => {
        if (definitionSearchAbortRef.current === controller) {
          definitionSearchAbortRef.current = null;
          setIsDefinitionSearchLoading(false);
        }
      });
  }, [t]);

  const scheduleDefinitionSearch = useCallback((nextQuery) => {
    if (definitionSearchDebounceRef.current) {
      clearTimeout(definitionSearchDebounceRef.current);
      definitionSearchDebounceRef.current = null;
    }
    if (String(nextQuery || "").trim().length < 2) {
      runDefinitionSearch(nextQuery);
      return;
    }
    setIsDefinitionSearchLoading(true);
    definitionSearchDebounceRef.current = setTimeout(() => {
      definitionSearchDebounceRef.current = null;
      runDefinitionSearch(nextQuery);
    }, LAW_SEARCH_DEBOUNCE_MS);
  }, [runDefinitionSearch]);

  const runFulltextSearch = useCallback((nextQuery) => {
    const trimmedQuery = String(nextQuery || "").trim();
    fulltextSearchAbortRef.current?.abort();
    setFulltextSearchError(null);

    if (trimmedQuery.length < 2) {
      setResults([]);
      setLastFulltextSearchQuery("");
      setIsFulltextSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    fulltextSearchAbortRef.current = controller;
    setIsFulltextSearchLoading(true);
    setLastFulltextSearchQuery(trimmedQuery);

    searchFulltextApi(trimmedQuery, { limit: 12, signal: controller.signal })
      .then((payload) => {
        if (fulltextSearchAbortRef.current !== controller) return;
        const sourceResults = Array.isArray(payload) ? payload : payload?.results;
        const nextResults = Array.isArray(sourceResults)
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
        setResults(nextResults);
        setSelectedIndex(-1);
      })
      .catch((error) => {
        if (error?.name === "AbortError" || fulltextSearchAbortRef.current !== controller) return;
        console.error("Failed to search full text", error);
        setResults([]);
        setFulltextSearchError(error);
      })
      .finally(() => {
        if (fulltextSearchAbortRef.current === controller) {
          fulltextSearchAbortRef.current = null;
          setIsFulltextSearchLoading(false);
        }
      });
  }, []);

  const scheduleFulltextSearch = useCallback((nextQuery) => {
    fulltextSearchAbortRef.current?.abort();
    fulltextSearchAbortRef.current = null;
    if (fulltextSearchDebounceRef.current) {
      clearTimeout(fulltextSearchDebounceRef.current);
      fulltextSearchDebounceRef.current = null;
    }
    if (String(nextQuery || "").trim().length < 2) {
      runFulltextSearch(nextQuery);
      return;
    }
    setIsFulltextSearchLoading(true);
    fulltextSearchDebounceRef.current = setTimeout(() => {
      fulltextSearchDebounceRef.current = null;
      runFulltextSearch(nextQuery);
    }, LAW_SEARCH_DEBOUNCE_MS);
  }, [runFulltextSearch]);

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
    scheduleDefinitionSearch,
    scheduleFulltextSearch,
    scheduleLawSearch,
    searchableLawCount,
  ]);

  // Trigger search data loading on open
  useEffect(() => {
    if (isOpen && isMatchesMode) {
      onSearchOpen?.();
    }
  }, [isMatchesMode, isOpen, onSearchOpen]);

  // Reset indices when source data changes
  useEffect(() => {
    setCurrentSearchIndex(null);
    setResults([]);
    setLawSearchError("");
    setFulltextSearchError(null);
  }, [lists]);

  useEffect(() => {
    setGlobalSearchIndex(null);
    setResults([]);
    setLawSearchError("");
    setFulltextSearchError(null);
  }, [effectiveGlobalLists]);

  // Build current-law index on open if needed
  useEffect(() => {
    if (isOpen && isCurrentMode && !currentSearchIndex && !isBuildingCurrent) {
      setIsBuildingCurrent(true);
      setTimeout(() => {
        try {
          const idx = buildSearchIndex(lists);
          setCurrentSearchIndex(idx);
        } catch (e) {
          console.error("Failed to build current search index", e);
        } finally {
          setIsBuildingCurrent(false);
        }
      }, 100);
    }
  }, [currentSearchIndex, isBuildingCurrent, isCurrentMode, isOpen, lists]);

  // Build global library index on open if needed
  useEffect(() => {
    if (isOpen && isMatchesMode && !isSearchLoading && !globalSearchIndex && !isBuildingGlobal) {
      setIsBuildingGlobal(true);
      setTimeout(() => {
        try {
          const idx = buildSearchIndex(effectiveGlobalLists || { articles: [], recitals: [], annexes: [] });
          setGlobalSearchIndex(idx);
        } catch (e) {
          console.error("Failed to build global search index", e);
        } finally {
          setIsBuildingGlobal(false);
        }
      }, 100);
    }
  }, [effectiveGlobalLists, globalSearchIndex, isBuildingGlobal, isMatchesMode, isOpen, isSearchLoading]);

  useEffect(() => () => {
    lawSearchAbortRef.current?.abort();
    definitionSearchAbortRef.current?.abort();
    fulltextSearchAbortRef.current?.abort();
    if (lawSearchDebounceRef.current) {
      clearTimeout(lawSearchDebounceRef.current);
    }
    if (definitionSearchDebounceRef.current) {
      clearTimeout(definitionSearchDebounceRef.current);
    }
    if (fulltextSearchDebounceRef.current) {
      clearTimeout(fulltextSearchDebounceRef.current);
    }
  }, []);

  // Prevent a delayed response from the mode the user just left replacing
  // the results for the newly selected mode.
  useEffect(() => {
    if (!isLawMode) {
      lawSearchRequestIdRef.current += 1;
      lawSearchAbortRef.current?.abort();
      lawSearchAbortRef.current = null;
      if (lawSearchDebounceRef.current) {
        clearTimeout(lawSearchDebounceRef.current);
        lawSearchDebounceRef.current = null;
      }
      setIsLawSearchLoading(false);
    }
    if (!isDefinitionsMode) {
      definitionSearchAbortRef.current?.abort();
      definitionSearchAbortRef.current = null;
      if (definitionSearchDebounceRef.current) {
        clearTimeout(definitionSearchDebounceRef.current);
        definitionSearchDebounceRef.current = null;
      }
      setIsDefinitionSearchLoading(false);
    }
    if (!isFulltextMode) {
      fulltextSearchAbortRef.current?.abort();
      fulltextSearchAbortRef.current = null;
      if (fulltextSearchDebounceRef.current) {
        clearTimeout(fulltextSearchDebounceRef.current);
        fulltextSearchDebounceRef.current = null;
      }
      setIsFulltextSearchLoading(false);
    }
  }, [isDefinitionsMode, isFulltextMode, isLawMode]);

  // Closing the spotlight is also a full-text search boundary: there is no
  // visible consumer left for a pending response, so cancel it immediately.
  useEffect(() => {
    if (isOpen || !isFulltextMode) return;
    fulltextSearchAbortRef.current?.abort();
    fulltextSearchAbortRef.current = null;
    if (fulltextSearchDebounceRef.current) {
      clearTimeout(fulltextSearchDebounceRef.current);
      fulltextSearchDebounceRef.current = null;
    }
    setIsFulltextSearchLoading(false);
  }, [isFulltextMode, isOpen]);

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

  useEffect(() => {
    if (!isOpen) return;
    focusModalInput();
  }, [focusModalInput, isOpen, searchMode]);

  useEffect(() => {
    if (!isOpen) return;

    const handleWindowFocus = () => {
      focusModalInput();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        focusModalInput();
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [focusModalInput, isOpen]);

  const handleSelect = useCallback((item) => {
    Promise.resolve(onNavigate(item));
    // setQuery(""); // Keep search term
    // setResults([]); // Keep results
    setIsOpen(false);
  }, [onNavigate]);

  // Close when pressing Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        modalInputRef.current?.blur();
      }
      // Command/Ctrl + K to open
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Keyboard navigation within modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + results.length) % results.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          handleSelect(results[selectedIndex]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSelect, isOpen, results, selectedIndex]);

  // Auto-scroll to selected item
  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selectedEl = resultsRef.current.querySelector(`[data-result-index="${selectedIndex}"]`);
      if (selectedEl?.scrollIntoView) {
        selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

  const handleSearch = (e) => {
    const q = e.target.value;
    setQuery(q);
    setSelectedIndex(-1);
    setLawSearchError("");
    setFulltextSearchError(null);

    if (!isOpen && triggerVariant === "hero") {
      if (q.trim().length === 0) {
        setResults([]);
        return;
      }
      setIsOpen(true);
    }

    if ((isLawMode && q.trim() !== lastLawSearchQuery)
      || (isDefinitionsMode && q.trim() !== lastDefinitionSearchQuery)
      || (isFulltextMode && q.trim() !== lastFulltextSearchQuery)) {
      setResults([]);
      return;
    }
    executeSearch(searchMode, q);
  };

  useEffect(() => {
    if (!isOpen || query.length < 2) return;
    if (isCurrentMode && !isBuildingCurrent) {
      runCurrentSearch(query);
    }
  }, [isBuildingCurrent, isCurrentMode, isOpen, query, runCurrentSearch]);

  useEffect(() => {
    if (!isOpen || query.length < 2) return;
    if (isMatchesMode && !isBuildingGlobal && !isSearchLoading) {
      runGlobalMatchSearch(query);
    }
  }, [globalEntryCount, isBuildingGlobal, isMatchesMode, isOpen, isSearchLoading, query, runGlobalMatchSearch]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIndex(-1);
    setResults([]);
    setLawSearchError("");
    setFulltextSearchError(null);
    if (isLawMode) {
      scheduleLawSearch(query);
      return;
    }
    executeSearch(searchMode, query);
  }, [executeSearch, isLawMode, isOpen, query, scheduleLawSearch, searchMode]);

  useEffect(() => {
    if (!isOpen) return;
    const pending = pendingSearchRef.current;
    if (!pending) return;

    if (pending.mode === "current" && !isBuildingCurrent) {
      pendingSearchRef.current = null;
      runCurrentSearch(pending.query);
      return;
    }

    if (pending.mode === "matches" && !isSearchLoading && !isBuildingGlobal) {
      if (
        typeof onSearchOpen === "function" && globalEntryCount === 0 && searchableLawCount > 0
      ) {
        return;
      }
      pendingSearchRef.current = null;
      runGlobalMatchSearch(pending.query);
    }
  }, [
    globalEntryCount,
    hasSearchInitialized,
    isBuildingCurrent,
    isBuildingGlobal,
    isOpen,
    isSearchLoading,
    onSearchOpen,
    runCurrentSearch,
    runGlobalMatchSearch,
    searchableLawCount,
  ]);

  const modeSummary = isCurrentMode
    ? t("search.searchingCurrentLaw", { law: currentLawLabel || t("search.currentLawFallback") })
    : isLawMode
      ? t("search.searchingLaws")
      : isDefinitionsMode
        ? t("search.searchingDefinitions")
        : isFulltextMode
          ? t("search.searchingFulltext")
      : t("search.searchingMatches", {
        count: searchableLawCount,
        lawWord: searchableLawCount === 1 ? t("search.law") : t("search.laws"),
        language: activeLanguage,
      });

  // Short muted scope sentence shown beneath the mode segmented control. For
  // laws mode the secondary-acts caveat lives in the footer instead, so the
  // scope line stays terse.
  const scopeSentence = isCurrentMode
    ? t("search.searchingCurrentLaw", { law: currentLawLabel || t("search.currentLawFallback") })
    : isLawMode
      ? t("search.scopeLaws")
      : isDefinitionsMode
        ? t("search.searchingDefinitions")
        : isFulltextMode
          ? t("search.scopeFulltext")
      : t("search.searchingMatches", {
        count: searchableLawCount,
        lawWord: searchableLawCount === 1 ? t("search.law") : t("search.laws"),
        language: activeLanguage,
      });

  const modeLabel = (mode) => (
    mode === "current"
      ? t("search.segCurrent")
      : mode === "laws"
        ? t("search.segLaws")
        : mode === "definitions"
          ? t("search.segDefinitions")
          : mode === "fulltext"
            ? t("search.segFulltext")
        : t("search.segMatches")
  );

  // Cycle the active mode with Tab / Shift+Tab while the dialog is open.
  const cycleMode = useCallback((direction) => {
    if (availableModes.length < 2) return;
    const currentIdx = availableModes.indexOf(searchMode);
    const nextIdx = (currentIdx + direction + availableModes.length) % availableModes.length;
    setSearchMode(availableModes[nextIdx]);
    setSelectedIndex(-1);
    setLawSearchError("");
    setFulltextSearchError(null);
    focusModalInput();
  }, [availableModes, focusModalInput, searchMode]);

  // Split laws-mode results into a "Best match" group (the synthetic
  // direct-open CELEX result, when present, plus the top backend hit) and an
  // "All results" group for the remainder. The concatenated render order is
  // identical to `results`, so keyboard selectedIndex still maps 1:1.
  const resultGroups = useMemo(() => {
    if (!isLawMode || results.length === 0) {
      return [{ label: null, items: results }];
    }
    const directResults = results.filter((r) => r.directCelex);
    const nonDirect = results.filter((r) => !r.directCelex);
    const bestItems = [...directResults, ...nonDirect.slice(0, 1)];
    const restItems = nonDirect.slice(1);
    const groups = [{ label: t("search.groupBestMatch"), items: bestItems }];
    if (restItems.length > 0) {
      groups.push({ label: t("search.groupAllResults"), items: restItems });
    }
    return groups;
  }, [isLawMode, results, t]);

  const inputPlaceholder = isBusy
    ? t("search.initializing")
    : isCurrentMode
      ? t("search.placeholderCurrentLaw", { law: currentLawLabel || t("search.currentLawFallback") })
      : isLawMode
        ? t("search.placeholderLaws")
        : isDefinitionsMode
          ? t("search.placeholderDefinitions")
          : isFulltextMode
            ? t("search.placeholderFulltext")
        : t("search.placeholderMatches");
  const heroSearchPlaceholder = isSmallViewport
    ? t("landing.searchPlaceholderMobile")
    : t("landing.searchPlaceholder");
  const isInputDisabled = isCurrentMode
    ? isBuildingCurrent
    : isMatchesMode
      ? (isBuildingGlobal || isSearchLoading)
      : false;
  const searchErrorMessage = isFulltextMode && fulltextSearchError
    ? (fulltextSearchError.status === 503 || fulltextSearchError.code === "fulltext_index_unavailable"
      ? t("search.fulltextApiUnavailable")
      : fulltextSearchError.message || t("search.fulltextApiUnavailable"))
    : lawSearchError;

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
      {isOpen && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/20 transition-all md:p-4 md:pt-[15vh]"
          onClick={() => setIsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("search.trigger")}
            className="w-full max-w-2xl flex flex-col h-full md:h-auto md:max-h-[70vh] bg-white shadow-2xl ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-100 overflow-hidden fixed inset-0 md:static md:inset-auto md:rounded-2xl dark:bg-gray-900 dark:ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with Auto-focused Input */}
            <div className="flex-none border-b border-gray-100 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 -ml-1 text-gray-500 hover:text-gray-900 md:hidden"
                >
                  <ChevronLeft size={24} />
                </button>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Search size={18} className="hidden shrink-0 text-gray-400 md:block" />
                  <div className="relative min-w-0 flex-1">
                    <input
                      ref={modalInputRef}
                      type="text"
                      value={query}
                      onChange={handleSearch}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && availableModes.length > 1) {
                          e.preventDefault();
                          cycleMode(e.shiftKey ? -1 : 1);
                          return;
                        }
                        if (isLawMode && e.key === "Enter" && selectedIndex < 0) {
                          e.preventDefault();
                          runLawSearch(query);
                        }
                      }}
                      placeholder={inputPlaceholder}
                      disabled={isInputDisabled}
                      className="h-10 w-full bg-transparent pr-8 text-base font-medium text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50 md:text-[1.05rem] dark:text-white dark:placeholder:text-gray-600"
                    />
                    {isBusy ? (
                      <div className="absolute right-0 top-1/2 -translate-y-1/2">
                        <Loader2 className="animate-spin text-blue-600" size={20} />
                      </div>
                    ) : query && (
                      <button
                        onClick={() => {
                          setQuery("");
                          setResults([]);
                          setDefinitionDiscoveryFilter("");
                          setLastFulltextSearchQuery("");
                          setFulltextSearchError(null);
                          focusModalInput();
                        }}
                        className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                        title={t("search.clear")}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="hidden shrink-0 items-center md:flex">
                  <button
                    onClick={() => setIsOpen(false)}
                    title={t("common.close")}
                    className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[10px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500 dark:hover:text-gray-300"
                  >
                    esc
                  </button>
                </div>
              </div>
            </div>

            {hasGlobalSearch && availableModes.length > 1 && (
              <div className="flex-none border-b border-gray-100 bg-gray-50/80 px-4 py-2.5 dark:border-gray-800 dark:bg-gray-950/60">
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    role="tablist"
                    aria-label={t("search.modeLabel")}
                    className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-950"
                  >
                    {availableModes.map((mode) => {
                      const active = searchMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => {
                            setSearchMode(mode);
                            setSelectedIndex(-1);
                            setLawSearchError("");
                            setFulltextSearchError(null);
                            focusModalInput();
                          }}
                          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                            active
                              ? "bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white"
                              : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                          }`}
                        >
                          {modeLabel(mode)}
                        </button>
                      );
                    })}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-gray-500 dark:text-gray-400">
                    {scopeSentence}
                  </span>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-2 scroll-smooth bg-gray-50/30 dark:bg-gray-950/50">
              {isDefinitionsMode ? (
                <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1 pt-1" aria-label={t("search.definitionDiscoveryLabel")}>
                  {[
                    { id: "", label: t("search.definitionDiscoveryAll") },
                    { id: "different", label: t("search.definitionDiscoveryDifferent") },
                    { id: "reused", label: t("search.definitionDiscoveryReused") },
                  ].map((entry) => (
                    <button
                      key={entry.id || "all"}
                      type="button"
                      aria-pressed={definitionDiscoveryFilter === entry.id}
                      onClick={() => {
                        setQuery("");
                        if (entry.id) runDefinitionSearch("", entry.id);
                        else {
                          definitionSearchAbortRef.current?.abort();
                          setDefinitionDiscoveryFilter("");
                          setResults([]);
                          setLastDefinitionSearchQuery("");
                          setIsDefinitionSearchLoading(false);
                        }
                        focusModalInput();
                      }}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                        definitionDiscoveryFilter === entry.id
                          ? "border-eu-blue bg-eu-blue-soft text-eu-blue dark:border-eu-blue-bright dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright"
                          : "border-gray-200 bg-white text-gray-500 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {searchErrorMessage ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Search size={48} className="opacity-10 mb-4" />
                  <p className="max-w-sm text-center text-sm">{searchErrorMessage}</p>
                </div>
              ) : isBusy ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Search size={48} className="opacity-20 mb-4 animate-pulse" />
                  <p className="text-sm text-center max-w-sm">{modeSummary}</p>
                </div>
              ) : results.length > 0 ? (
                <div className="flex flex-col p-2 w-full" ref={resultsRef}>
                  {(() => {
                    let flatIndex = -1;
                    return resultGroups.map((group, gi) => (
                      <div key={group.label || `group-${gi}`} className="flex flex-col">
                        {group.label ? (
                          <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                            {group.label}
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-1">
                          {group.items.map((item) => {
                            flatIndex += 1;
                            const idx = flatIndex;
                            const isSelected = idx === selectedIndex;
                            const dense = gi > 0;
                            const lawDisplay = item.search_kind === "law" ? getLawResultDisplay(item) : null;
                            return (
                              <button
                                type="button"
                                key={`${item.search_kind || item.type}-${item.id}-${idx}`}
                                data-result-index={idx}
                                onClick={() => handleSelect(item)}
                                className={`group flex w-full flex-col gap-1 rounded-xl px-3 text-left transition-colors ${dense ? "py-2" : "py-2.5"} ${
                                  isSelected
                                    ? "bg-eu-blue-soft dark:bg-eu-blue-soft-dark"
                                    : "hover:bg-eu-blue-soft/60 dark:hover:bg-eu-blue-soft-dark/60"
                                }`}
                              >
                                {item.search_kind === "definition" ? (
                                  <DefinitionSearchResult item={item} query={query} t={t} />
                                ) : item.search_kind === "fulltext" ? (
                                  <FulltextSearchResult item={item} t={t} />
                                ) : item.search_kind === "law" ? (
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
                                ) : (
                                  <>
                                    <div className="flex w-full min-w-0 items-center gap-2.5">
                                      <span className={`flex-shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                        item.type === "article"
                                          ? "border-blue-100 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                                          : item.type === "recital"
                                            ? "border-purple-100 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
                                            : "border-orange-100 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-900/40 dark:text-orange-200"
                                      }`}>
                                        {item.type}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate font-semibold text-base text-gray-900 group-hover:text-eu-blue dark:text-gray-100 dark:group-hover:text-eu-blue-bright">
                                        {item.title}
                                      </span>
                                      {item.score > 100 && (
                                        <span className="flex-shrink-0 rounded-full bg-green-100 px-1.5 text-[10px] font-medium text-green-700 dark:bg-green-900/50 dark:text-green-200">{t("search.bestMatch")}</span>
                                      )}
                                      {item.law_label && (
                                        <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                                          {item.law_label}
                                        </span>
                                      )}
                                    </div>
                                    <p className="pl-1 text-sm leading-relaxed text-gray-500 line-clamp-2 dark:text-gray-300">
                                      <span className="opacity-70">...</span>
                                      {item.preview}
                                      <span className="opacity-70">...</span>
                                    </p>
                                  </>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  {isFulltextMode && lastFulltextSearchQuery.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">{t("search.typeFulltext")}</p>
                    </>
                  ) : isFulltextMode ? (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noResultsFulltext", { query: lastFulltextSearchQuery })}
                      </p>
                    </>
                  ) : isDefinitionsMode && lastDefinitionSearchQuery.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">{t("search.typeDefinitions")}</p>
                    </>
                  ) : isDefinitionsMode ? (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noResultsDefinitions", { query: lastDefinitionSearchQuery })}
                      </p>
                    </>
                  ) : isLawMode && lastLawSearchQuery.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.typeLaws")}
                      </p>
                    </>
                  ) : isLawMode ? (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noResultsLaws", { query: lastLawSearchQuery })}
                      </p>
                    </>
                  ) : isCurrentMode && query.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.typeCurrentLaw", { law: currentLawLabel || t("search.currentLawFallback") })}
                      </p>
                    </>
                  ) : isCurrentMode ? (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noResultsCurrentLaw", { query, law: currentLawLabel || t("search.currentLawFallback") })}
                      </p>
                    </>
                  ) : isMatchesMode && searchableLawCount === 0 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noCached", { language: activeLanguage })}
                      </p>
                    </>
                  ) : isMatchesMode && query.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.typeCached", {
                          count: searchableLawCount,
                          lawWord: searchableLawCount === 1 ? t("search.law") : t("search.laws"),
                          language: activeLanguage,
                        })}
                      </p>
                    </>
                  ) : !hasGlobalSearch && query.length < 2 ? (
                    <>
                      <Search size={48} className="opacity-10 mb-4" />
                      <p className="text-sm">{t("search.typeToStart")}</p>
                    </>
                  ) : isMatchesMode ? (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm text-center max-w-sm">
                        {t("search.noResultsCached", {
                          query,
                          count: searchableLawCount,
                          lawWord: searchableLawCount === 1 ? t("search.law") : t("search.laws"),
                          language: activeLanguage,
                        })}
                      </p>
                    </>
                  ) : (
                    <>
                      <Search size={48} className="opacity-20 mb-4" />
                      <p className="text-sm">{t("search.noResults", { query })}</p>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="hidden md:flex flex-none items-center gap-4 border-t border-gray-100 bg-gray-50 px-4 py-2 text-[10px] text-gray-400 dark:bg-gray-900 dark:border-gray-800 dark:text-gray-500">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-gray-200 bg-white px-1 font-mono dark:border-gray-700 dark:bg-gray-800">↑↓</kbd>
                {t("search.footNavigate")}
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-gray-200 bg-white px-1 font-mono dark:border-gray-700 dark:bg-gray-800">↵</kbd>
                {t("search.footOpen")}
              </span>
              {availableModes.length > 1 && (
                <span className="flex items-center gap-1.5">
                  <kbd className="rounded border border-gray-200 bg-white px-1 font-mono dark:border-gray-700 dark:bg-gray-800">⇥</kbd>
                  {t("search.footMode")}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-gray-200 bg-white px-1 font-mono dark:border-gray-700 dark:bg-gray-800">esc</kbd>
                {t("search.footClose")}
              </span>
              {isFulltextMode ? (
                <span className="ml-auto text-gray-400 dark:text-gray-500">{t("search.fulltextEnglishOnly")}</span>
              ) : isLawMode ? (
                <span className="ml-auto text-gray-400 dark:text-gray-500">{t("search.secondaryNotIndexed")}</span>
              ) : null}
            </div>
          </div>
        </div>,
        document.body
      )}
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
