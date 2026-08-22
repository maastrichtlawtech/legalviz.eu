import { useCallback, useEffect, useRef, useState } from "react";
import { buildSearchIndex, searchContent, searchIndex as searchWithIndex } from "../../utils/nlp.js";

// Owns the client-side search indexes SearchBox uses for the "current" and
// "matches" modes: the per-law index and the whole-library index, each built
// lazily from the loaded source lists via a setTimeout, plus the orchestration
// that runs a search once the relevant index is ready. The networked modes
// (laws, definitions, fulltext) live in useNetworkedSearch, not here.
export function useLocalSearchIndexes({
  lists,
  globalLists,
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
}) {
  const [currentSearchIndex, setCurrentSearchIndex] = useState(null);
  const [globalSearchIndex, setGlobalSearchIndex] = useState(null);
  const [isBuildingCurrent, setIsBuildingCurrent] = useState(false);
  const [isBuildingGlobal, setIsBuildingGlobal] = useState(false);

  const isCurrentMode = searchMode === "current";
  const isMatchesMode = searchMode === "matches";

  const runCurrentSearch = useCallback((nextQuery) => {
    if (nextQuery.length < 2) {
      setResults([]);
      return;
    }

    const nextResults = currentSearchIndex
      ? searchWithIndex(nextQuery, currentSearchIndex)
      : searchContent(nextQuery, lists);
    setResults(nextResults);
  }, [currentSearchIndex, lists, setResults]);

  const runGlobalMatchSearch = useCallback((nextQuery, sourceLists = globalLists, sourceIndex = globalSearchIndex) => {
    if (nextQuery.length < 2) {
      setResults([]);
      return;
    }

    const nextResults = sourceIndex
      ? searchWithIndex(nextQuery, sourceIndex)
      : searchContent(nextQuery, sourceLists || { articles: [], recitals: [], annexes: [] });
    setResults(nextResults);
  }, [globalLists, globalSearchIndex, setResults]);

  // A failed build must not re-arm the setTimeout loop on every render pass
  // while the dialog stays open. Latch the failure against the source list it
  // came from, and reset the latch only when that list actually changes, so a
  // genuinely transient failure still gets one retry on new input.
  const currentBuildFailedRef = useRef(false);
  const currentSourceRef = useRef(lists);
  const globalBuildFailedRef = useRef(false);
  const globalSourceRef = useRef(globalLists);

  useEffect(() => {
    if (currentSourceRef.current !== lists) {
      currentSourceRef.current = lists;
      currentBuildFailedRef.current = false;
      setCurrentSearchIndex(null);
    }
  }, [lists]);

  useEffect(() => {
    if (globalSourceRef.current !== globalLists) {
      globalSourceRef.current = globalLists;
      globalBuildFailedRef.current = false;
      setGlobalSearchIndex(null);
    }
  }, [globalLists]);

  // Build current-law index on open if needed
  useEffect(() => {
    if (
      isOpen
      && isCurrentMode
      && !currentSearchIndex
      && !isBuildingCurrent
      && !currentBuildFailedRef.current
    ) {
      setIsBuildingCurrent(true);
      setTimeout(() => {
        try {
          const idx = buildSearchIndex(lists);
          setCurrentSearchIndex(idx);
        } catch (e) {
          console.error("Failed to build current search index", e);
          currentBuildFailedRef.current = true;
        } finally {
          setIsBuildingCurrent(false);
        }
      }, 100);
    }
  }, [currentSearchIndex, isBuildingCurrent, isCurrentMode, isOpen, lists]);

  // Build global library index on open if needed
  useEffect(() => {
    if (
      isOpen
      && isMatchesMode
      && !isSearchLoading
      && !globalSearchIndex
      && !isBuildingGlobal
      && !globalBuildFailedRef.current
    ) {
      setIsBuildingGlobal(true);
      setTimeout(() => {
        try {
          const idx = buildSearchIndex(globalLists || { articles: [], recitals: [], annexes: [] });
          setGlobalSearchIndex(idx);
        } catch (e) {
          console.error("Failed to build global search index", e);
          globalBuildFailedRef.current = true;
        } finally {
          setIsBuildingGlobal(false);
        }
      }, 100);
    }
  }, [globalLists, globalSearchIndex, isBuildingGlobal, isMatchesMode, isOpen, isSearchLoading]);

  // Run the current/matches search as the query settles and the index is ready.
  // Run the current/matches search as the query settles and the index is
  // ready. A sub-minimum query clears the results instead of returning
  // early: nothing else resets them for these modes, so backspacing below
  // two characters would otherwise leave stale rows on screen.
  useEffect(() => {
    if (!isOpen || !isCurrentMode) return;
    if (query.length < 2) {
      setResults([]);
      return;
    }
    if (!isBuildingCurrent) {
      runCurrentSearch(query);
    }
  }, [isBuildingCurrent, isCurrentMode, isOpen, query, runCurrentSearch, setResults]);

  useEffect(() => {
    if (!isOpen || !isMatchesMode) return;
    if (query.length < 2) {
      setResults([]);
      return;
    }
    if (!isBuildingGlobal && !isSearchLoading) {
      runGlobalMatchSearch(query);
    }
  }, [globalEntryCount, isBuildingGlobal, isMatchesMode, isOpen, isSearchLoading, query, runGlobalMatchSearch, setResults]);

  // Resolve a deferred search once the reason it was deferred clears.
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
    pendingSearchRef,
  ]);

  return {
    currentSearchIndex,
    globalSearchIndex,
    isBuildingCurrent,
    isBuildingGlobal,
    runCurrentSearch,
    runGlobalMatchSearch,
  };
}
