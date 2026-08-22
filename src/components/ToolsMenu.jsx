import { useState, useEffect, useRef } from "react";
import { ExternalLink, Printer, PanelLeftClose, PanelLeftOpen, Minus, Plus, MoreVertical, RotateCcw } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle.jsx";
import { useI18n } from "../i18n/useI18n.js";

export function ToolsMenu({
  onPrint,
  showPrint,
  onIncreaseFont,
  onDecreaseFont,
  fontSize,
  eurlexUrl,
  onToggleSidebar,
  isSidebarOpen,
  onToggleSecondLanguage,
  isSideBySide,
  onResetApp,
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`p-2 rounded-lg transition-colors ${isOpen ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'}`}
        title={t("topBar.moreTools")}
      >
        <MoreVertical size={20} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-56 p-2 bg-white rounded-xl shadow-xl ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 flex flex-col gap-1 z-50 animate-in fade-in zoom-in-95 duration-100">

          {onToggleSidebar && (
            <button
              onClick={() => { onToggleSidebar(); setIsOpen(false); }}
              className="hidden md:flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              <span>{isSidebarOpen ? t("topBar.hideSidebar") : t("topBar.showSidebar")}</span>
            </button>
          )}

          {showPrint && (
            <button
              onClick={() => { onPrint(); setIsOpen(false); }}
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Printer size={18} />
              <span>{t("topBar.printPdf")}</span>
            </button>
          )}

          {onToggleSecondLanguage && (
            <button
              type="button"
              onClick={() => {
                onToggleSecondLanguage();
                setIsOpen(false);
              }}
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <PanelLeftOpen size={18} />
              <span>
                {isSideBySide
                  ? t("topBar.closeSideBySide")
                  : t("topBar.openSideBySide")}
              </span>
            </button>
          )}

          {eurlexUrl && (
            <a
              href={eurlexUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <ExternalLink size={18} />
              <span>{t("topBar.viewOnEurlex")}</span>
            </a>
          )}

          {onResetApp && (
            <button
              type="button"
              onClick={() => {
                onResetApp();
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <RotateCcw size={18} />
              <span className="min-w-0 flex-1 text-left">{t("resetFooter.button")}</span>
            </button>
          )}

          <div className="px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-200">{t("common.theme")}</span>
              <ThemeToggle />
            </div>
          </div>

          {/* Font Size */}
          <div className="px-3 py-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onDecreaseFont}
                className="rounded-lg p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              >
                <Minus size={16} />
              </button>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{fontSize}%</span>
              <button
                type="button"
                onClick={onIncreaseFont}
                className="rounded-lg p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}