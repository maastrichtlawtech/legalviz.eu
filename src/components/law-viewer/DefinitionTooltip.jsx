import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const CLOSE_DELAY_MS = 150;
// Below this width an anchored popup has nowhere sensible to go, so we
// render a bottom sheet instead.
const SHEET_MEDIA_QUERY = "(max-width: 640px)";

function matchesSheetQuery() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(SHEET_MEDIA_QUERY).matches
    : false;
}

/**
 * Single shared popup for the `.defined-term` spans that
 * injectDefinitionTooltips() plants inside the EUR-Lex HTML.
 *
 * The law text is injected via dangerouslySetInnerHTML, so nothing React can
 * live inside it: this component listens for hover/click on document and
 * renders exactly one popup through a portal on document.body. Rendering
 * outside the EUR-Lex DOM keeps its tables, overflow rules, and stacking
 * contexts from clipping or restyling the popup.
 */
export function DefinitionTooltip({ t }) {
  // { term, definition, anchor } — anchor is the hovered/tapped span.
  const [active, setActive] = useState(null);
  const [isSheet, setIsSheet] = useState(matchesSheetQuery);
  const [position, setPosition] = useState(null);
  const tooltipRef = useRef(null);
  const closeTimerRef = useRef(null);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelScheduledClose();
    setActive(null);
  }, [cancelScheduledClose]);

  // Grace period on mouse-out so the pointer can travel into the popup
  // (e.g. to select the definition text) without it vanishing.
  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setActive(null), CLOSE_DELAY_MS);
  }, [cancelScheduledClose]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(SHEET_MEDIA_QUERY);
    const handleChange = (event) => setIsSheet(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const openFromElement = (el) => {
      cancelScheduledClose();
      setActive({
        term: el.getAttribute("data-term") || el.textContent,
        definition: el.getAttribute("data-definition") || "",
        anchor: el,
      });
    };

    const findTerm = (eventTarget) => {
      if (!(eventTarget instanceof Element)) return null;
      // Terms inside cross-reference links stay links: navigation wins.
      if (eventTarget.closest("a")) return null;
      return eventTarget.closest(".defined-term");
    };

    const handleMouseOver = (event) => {
      if (isSheet) return; // sheet mode is tap-to-open only
      const el = findTerm(event.target);
      if (el) openFromElement(el);
    };

    const handleMouseOut = (event) => {
      if (isSheet) return;
      if (findTerm(event.target)) scheduleClose();
    };

    // Explicit tap-to-open: synthetic mouseover on touch devices is too
    // unreliable to be the only way in.
    const handleClick = (event) => {
      const el = findTerm(event.target);
      if (el) {
        openFromElement(el);
        return;
      }
      if (tooltipRef.current?.contains(event.target)) return;
      close();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") close();
    };

    // Any scroll invalidates the anchored position; the sheet is
    // viewport-fixed, so only close when the popup itself isn't scrolling.
    const handleScroll = (event) => {
      if (isSheet && event.target instanceof Node && tooltipRef.current?.contains(event.target)) return;
      if (!isSheet) close();
    };

    document.addEventListener("mouseover", handleMouseOver);
    document.addEventListener("mouseout", handleMouseOut);
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("mouseout", handleMouseOut);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("resize", close);
      cancelScheduledClose();
    };
  }, [cancelScheduledClose, close, isSheet, scheduleClose]);

  // Anchored placement: measure the rendered popup, center it on the term,
  // clamp to the viewport, and flip below when there is no room above.
  useLayoutEffect(() => {
    if (!active || isSheet) {
      setPosition(null);
      return;
    }
    if (!active.anchor.isConnected) {
      setActive(null);
      return;
    }
    const el = tooltipRef.current;
    if (!el) return;

    const anchorRect = active.anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = el;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.left + anchorRect.width / 2 - width / 2;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - width - VIEWPORT_MARGIN));

    let top = anchorRect.top - height - ANCHOR_GAP;
    if (top < VIEWPORT_MARGIN) {
      top = anchorRect.bottom + ANCHOR_GAP;
    }
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - height - VIEWPORT_MARGIN));

    setPosition({ left, top });
  }, [active, isSheet]);

  if (!active || typeof document === "undefined") return null;

  if (isSheet) {
    return createPortal(
      <div
        ref={tooltipRef}
        role="dialog"
        aria-label={active.term}
        className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-gray-200 bg-white px-5 pt-4 shadow-[0_-8px_30px_rgba(0,0,0,0.15)] dark:border-gray-700 dark:bg-gray-900"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="pt-1.5 text-sm font-semibold text-blue-600 dark:text-blue-400">
            {active.term}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t("common.close")}
            className="-mr-2 rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-1 max-h-[45vh] overflow-y-auto text-sm leading-6 text-gray-700 dark:text-gray-300">
          {active.definition}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="fixed z-50 w-max max-w-sm rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onMouseEnter={cancelScheduledClose}
      onMouseLeave={scheduleClose}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
        {active.term}
      </div>
      <div className="mt-1 max-h-60 overflow-y-auto text-sm leading-6 text-gray-700 dark:text-gray-300">
        {active.definition}
      </div>
    </div>,
    document.body
  );
}
