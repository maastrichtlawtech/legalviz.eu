import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { CornerDownLeft } from "lucide-react";
import { NavigationControls } from "../NavigationControls.jsx";
import { parseJumpQuery } from "../../utils/law-viewer/jumpParser.js";

const MotionDiv = motion.div;

// Whether a keystroke should be treated as a global shortcut (nothing is being
// typed, no modifier held, and no dialog is open on top of the reader).
function isGlobalShortcutContext(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return false;
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"]')) return false;
  return true;
}

export function LawViewerQuickNavigation({
  selected,
  lists,
  onPrevNext,
  selectArticleIdx,
  selectRecitalIdx,
  selectAnnexIdx,
  closeMobileMenu,
  t,
}) {
  const [value, setValue] = useState("");
  const [hasError, setHasError] = useState(false);
  const inputRef = useRef(null);
  const controls = useAnimationControls();
  const prefersReducedMotion = useReducedMotion();

  const signalError = useCallback(() => {
    setHasError(true);
    if (!prefersReducedMotion) {
      controls.start({ x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.3 } });
    }
  }, [controls, prefersReducedMotion]);

  const navigateTo = useCallback((target) => {
    if (target.kind === "annex") {
      if (!lists.annexes?.length || target.number > lists.annexes.length) return false;
      selectAnnexIdx(target.number - 1);
      closeMobileMenu();
      return true;
    }
    if (target.kind === "recital") {
      if (!lists.recitals?.length || target.number > lists.recitals.length) return false;
      selectRecitalIdx(target.number - 1);
      closeMobileMenu();
      return true;
    }
    // article: match by article_number first (labels may skip/repeat numbers),
    // then fall back to a positional index — matching the previous selectors.
    if (!lists.articles?.length) return false;
    const byNumber = lists.articles.findIndex(
      (article) => Number.parseInt(article.article_number, 10) === target.number
    );
    if (byNumber !== -1) {
      selectArticleIdx(byNumber);
      closeMobileMenu();
      return true;
    }
    if (target.number > lists.articles.length) return false;
    selectArticleIdx(target.number - 1);
    closeMobileMenu();
    return true;
  }, [closeMobileMenu, lists, selectAnnexIdx, selectArticleIdx, selectRecitalIdx]);

  const submit = useCallback(() => {
    const target = parseJumpQuery(value);
    if (!target || !navigateTo(target)) {
      signalError();
      return;
    }
    setHasError(false);
    setValue("");
  }, [navigateTo, signalError, value]);

  // Global "g" shortcut focuses the jump box.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "g" || !isGlobalShortcutContext(event)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div>
      <div className="mb-4 hidden md:block">
        <NavigationControls
          selected={selected}
          lists={lists}
          onPrevNext={onPrevNext}
          className="w-full"
        />
      </div>

      <MotionDiv animate={controls}>
        <div
          className={`flex items-center gap-2 rounded-xl border bg-gray-50 px-3 py-2 transition-colors dark:bg-gray-800/60 ${
            hasError
              ? "border-red-300 dark:border-red-800"
              : "border-gray-200 focus-within:border-eu-blue dark:border-gray-700 dark:focus-within:border-eu-blue-bright"
          }`}
        >
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (hasError) setHasError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t("lawViewer.jumpPlaceholder")}
            aria-label={t("lawViewer.jumpAriaLabel")}
            aria-invalid={hasError}
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={submit}
            title={t("common.go")}
            aria-label={t("common.go")}
            className="flex shrink-0 items-center justify-center rounded-lg p-1 text-gray-400 transition-colors hover:text-eu-blue dark:hover:text-eu-blue-bright"
          >
            <CornerDownLeft size={16} />
          </button>
          <kbd className="hidden shrink-0 rounded border border-gray-200 px-1.5 font-mono text-[10px] text-gray-400 sm:block dark:border-gray-700 dark:text-gray-500">
            g
          </kbd>
        </div>
      </MotionDiv>

      <p
        className={`mt-1.5 px-1 text-xs ${
          hasError ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500"
        }`}
      >
        {hasError ? t("lawViewer.jumpError") : t("lawViewer.jumpHelp")}
      </p>
    </div>
  );
}
