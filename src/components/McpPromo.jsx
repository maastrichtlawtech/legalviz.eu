import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronRight, Copy, ExternalLink, X } from "lucide-react";
import { useI18n } from "../i18n/useI18n.js";

export const MCP_SERVER_URL = "https://api.legalviz.eu/mcp";
const MCP_DOCS_URL =
  "https://github.com/maastrichtlawtech/eur-lex-visualiser/blob/main/backend/README.md#mcp-server";

// Once the user has opened the promo anywhere (landing teaser or top bar), stop
// drawing attention to it: the top-bar button keeps working but loses its dot.
const MCP_PROMO_SEEN_KEY = "legalviz_mcp_promo_seen";

function hasSeenMcpPromo() {
  try {
    return localStorage.getItem(MCP_PROMO_SEEN_KEY) === "1";
  } catch {
    // If storage is unavailable we cannot persist a dismissal, so never nag.
    return true;
  }
}

function markMcpPromoSeen() {
  try {
    localStorage.setItem(MCP_PROMO_SEEN_KEY, "1");
  } catch {
    // ignore persistence failures
  }
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => {
      // Clipboard API can be blocked (permissions, insecure context); fall back.
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        textarea.remove();
        return ok;
      } catch {
        return false;
      }
    }
  );
}

function ClientRow({ name, steps }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold text-eu-navy dark:text-paper">{name}</span>
      <span className="text-sm text-gray-600 dark:text-gray-400">{steps}</span>
    </div>
  );
}

export function McpModal({ onClose, t }) {
  const panelRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef(null);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Focus the dialog on open; restore focus on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  const handleCopy = async () => {
    if (!(await copyToClipboard(MCP_SERVER_URL))) return;
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("landing.mcpTitle")}
        tabIndex={-1}
        className="relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl outline-none animate-in zoom-in-95 duration-200 dark:bg-panel-dark"
      >
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-4 top-4 rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <X size={20} />
        </button>

        <div className="mb-5">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-eu-blue dark:bg-gray-800 dark:text-eu-blue-bright">
            <Bot size={24} />
          </div>
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-eu-gold-deep dark:text-eu-gold-bright">
            {t("landing.mcpEyebrow")}
          </span>
          <h2 className="mt-1 font-display text-xl font-bold text-eu-navy dark:text-paper">
            {t("landing.mcpTitle")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            {t("landing.mcpDescription")}
          </p>
        </div>

        <div className="mb-5">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("landing.mcpUrlLabel")}
          </span>
          <div className="mt-1.5 flex items-stretch gap-2">
            <code
              className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-xl border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm text-eu-navy dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              data-testid="mcp-url"
            >
              {MCP_SERVER_URL}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex flex-none items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm transition hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("landing.mcpCopied") : t("landing.mcpCopy")}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <ClientRow name="ChatGPT" steps={t("landing.mcpChatgptSteps")} />
          <ClientRow name="Claude" steps={t("landing.mcpClaudeSteps")} />
          <ClientRow name={t("landing.mcpOthersName")} steps={t("landing.mcpOthersSteps")} />
          <a
            href={MCP_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-eu-blue transition hover:text-eu-navy dark:text-eu-blue-bright dark:hover:text-paper"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t("landing.mcpDocs")}
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Compact pill on the landing page that opens the MCP modal. */
export function McpLandingTeaser({ t }) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpen = () => {
    markMcpPromoSeen();
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="group inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 shadow-sm transition hover:border-eu-blue/40 hover:text-eu-navy hover:shadow-md dark:border-gray-800 dark:bg-panel-dark dark:text-gray-300 dark:hover:border-eu-blue/50 dark:hover:text-paper"
      >
        <Bot className="h-4 w-4 text-eu-blue dark:text-eu-blue-bright" aria-hidden="true" />
        <span>{t("landing.mcpTitle")}</span>
        <ChevronRight
          className="h-4 w-4 text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-eu-blue dark:group-hover:text-eu-blue-bright"
          aria-hidden="true"
        />
      </button>
      {isOpen ? <McpModal onClose={() => setIsOpen(false)} t={t} /> : null}
    </>
  );
}

/**
 * Icon button for the top bar. Carries a small dot until the user opens the
 * promo once (persisted in localStorage), then stays as a quiet tool button.
 */
export function McpTopBarButton() {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [seen, setSeen] = useState(hasSeenMcpPromo);

  const handleOpen = () => {
    markMcpPromoSeen();
    setSeen(true);
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title={t("landing.mcpTitle")}
        aria-label={t("landing.mcpTitle")}
        className="relative inline-flex items-center gap-1.5 rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
      >
        <Bot size={20} />
        <span className="text-xs font-semibold">{t("landing.mcpShortLabel")}</span>
        {!seen ? (
          <span
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-eu-gold-deep dark:bg-eu-gold-bright"
            aria-hidden="true"
          />
        ) : null}
      </button>
      {isOpen ? <McpModal onClose={() => setIsOpen(false)} t={t} /> : null}
    </>
  );
}
