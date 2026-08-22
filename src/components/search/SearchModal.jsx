import { useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Search, X, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n/useI18n.js";
import { SearchResults } from "./results/SearchResults.jsx";

export function SearchModal({
  isOpen,
  onOpen,
  onClose,
  query,
  onQueryChange,
  onClear,
  results,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
  searchMode,
  onSearchModeChange,
  onClearErrors,
  availableModes,
  onExecuteLawSearch,
  definitionDiscoveryFilter,
  onDefinitionDiscovery,
  isBusy,
  isInputDisabled,
  hasGlobalSearch,
  lawError,
  definitionError,
  fulltextError,
  searchableLawCount,
  activeLanguage,
  currentLawLabel,
  lawLastQuery,
  definitionLastQuery,
  fulltextLastQuery,
}) {
  const { t } = useI18n();
  const modalInputRef = useRef(null);
  const resultsRef = useRef(null);

  const isCurrentMode = searchMode === "current";
  const isLawMode = searchMode === "laws";
  const isMatchesMode = searchMode === "matches";
  const isDefinitionsMode = searchMode === "definitions";
  const isFulltextMode = searchMode === "fulltext";

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

  // Close when pressing Escape; Command/Ctrl + K to open
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
        modalInputRef.current?.blur();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onOpen]);

  // Keyboard navigation within modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelectedIndexChange(prev => (prev + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onSelectedIndexChange(prev => (prev - 1 + results.length) % results.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          onSelect(results[selectedIndex]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSelect, isOpen, results, selectedIndex, onSelectedIndexChange]);

  // Auto-scroll to selected item
  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selectedEl = resultsRef.current.querySelector(`[data-result-index="${selectedIndex}"]`);
      if (selectedEl?.scrollIntoView) {
        selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

  // Switch the active mode: update state, reset selection and clear errors,
  // then return focus to the input. Shared by the mode tabs and Tab cycling.
  const switchMode = useCallback((mode) => {
    onSearchModeChange(mode);
    onSelectedIndexChange(-1);
    onClearErrors();
    focusModalInput();
  }, [focusModalInput, onClearErrors, onSearchModeChange, onSelectedIndexChange]);

  // Cycle the active mode with Tab / Shift+Tab while the dialog is open.
  const cycleMode = useCallback((direction) => {
    if (availableModes.length < 2) return;
    const currentIdx = availableModes.indexOf(searchMode);
    const nextIdx = (currentIdx + direction + availableModes.length) % availableModes.length;
    switchMode(availableModes[nextIdx]);
  }, [availableModes, searchMode, switchMode]);

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

  const lawSearchError = lawError
    ? lawError?.message || t("search.apiUnavailable")
    : "";
  const definitionSearchError = definitionError
    ? definitionError?.message || t("search.definitionApiUnavailable")
    : "";
  const searchErrorMessage = isFulltextMode && fulltextError
    ? (fulltextError.status === 503 || fulltextError.code === "fulltext_index_unavailable"
      ? t("search.fulltextApiUnavailable")
      : fulltextError.message || t("search.fulltextApiUnavailable"))
    : isDefinitionsMode
      ? definitionSearchError
      : lawSearchError;

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/20 transition-all md:p-4 md:pt-[15vh]"
      onClick={onClose}
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
              onClick={onClose}
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
                  onChange={onQueryChange}
                  onKeyDown={(e) => {
                    if (e.key === "Tab" && availableModes.length > 1) {
                      e.preventDefault();
                      cycleMode(e.shiftKey ? -1 : 1);
                      return;
                    }
                    if (isLawMode && e.key === "Enter" && selectedIndex < 0) {
                      e.preventDefault();
                      onExecuteLawSearch(query);
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
                      onClear();
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
                onClick={onClose}
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
                      onClick={() => switchMode(mode)}
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
                    onDefinitionDiscovery(entry.id);
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
            <SearchResults
              results={results}
              searchMode={searchMode}
              selectedIndex={selectedIndex}
              query={query}
              t={t}
              onSelect={onSelect}
              resultsRef={resultsRef}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              {isFulltextMode && fulltextLastQuery.length < 2 ? (
                <>
                  <Search size={48} className="opacity-10 mb-4" />
                  <p className="text-sm text-center max-w-sm">{t("search.typeFulltext")}</p>
                </>
              ) : isFulltextMode ? (
                <>
                  <Search size={48} className="opacity-20 mb-4" />
                  <p className="text-sm text-center max-w-sm">
                    {t("search.noResultsFulltext", { query: fulltextLastQuery })}
                  </p>
                </>
              ) : isDefinitionsMode && definitionLastQuery.length < 2 ? (
                <>
                  <Search size={48} className="opacity-10 mb-4" />
                  <p className="text-sm text-center max-w-sm">{t("search.typeDefinitions")}</p>
                </>
              ) : isDefinitionsMode ? (
                <>
                  <Search size={48} className="opacity-20 mb-4" />
                  <p className="text-sm text-center max-w-sm">
                    {t("search.noResultsDefinitions", { query: definitionLastQuery })}
                  </p>
                </>
              ) : isLawMode && lawLastQuery.length < 2 ? (
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
                    {t("search.noResultsLaws", { query: lawLastQuery })}
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
  );
}
