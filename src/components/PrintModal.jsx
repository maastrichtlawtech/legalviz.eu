import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Printer, Check } from "lucide-react";
import { Button } from "./Button.jsx";
import { useI18n } from "../i18n/useI18n.js";

export function PrintModal({ isOpen, onClose, onPrint, counts }) {
  const { t } = useI18n();
  const panelRef = useRef(null);
  const [options, setOptions] = useState({
    recitals: false,
    articles: true,
    annexes: false,
    relatedRecitals: false,
  });

  // Close on Escape
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  // Focus the dialog on open; restore focus on close.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePrint = () => {
    onPrint(options);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("printModal.title")}
        tabIndex={-1}
        className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 animate-in zoom-in-95 duration-200 outline-none"
      >
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-4 top-4 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors"
        >
          <X size={20} />
        </button>

        <div className="mb-6">
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center mb-4">
            <Printer size={24} />
          </div>
          <h2 className="text-xl font-bold text-gray-900">{t("printModal.title")}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {t("printModal.description")}
          </p>
        </div>

        <div className="space-y-4 mb-8">
          {/* Main Sections */}
          <div className="space-y-3">
            <label className="flex items-center justify-between p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/30 cursor-pointer transition-all group">
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  options.recitals ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300 group-hover:border-blue-400"
                }`}>
                  {options.recitals && <Check size={12} className="text-white" />}
                </div>
                <div className="flex flex-col">
                  <span className="font-medium text-gray-900">{t("common.recitals")}</span>
                  <span className="text-xs text-gray-500">{t("printModal.itemsAvailable", { count: counts.recitals })}</span>
                </div>
              </div>
              <input 
                type="checkbox" 
                className="hidden" 
                checked={options.recitals} 
                onChange={() => setOptions(p => ({ ...p, recitals: !p.recitals }))}
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/30 cursor-pointer transition-all group">
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  options.articles ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300 group-hover:border-blue-400"
                }`}>
                  {options.articles && <Check size={12} className="text-white" />}
                </div>
                <div className="flex flex-col">
                  <span className="font-medium text-gray-900">{t("common.articles")}</span>
                  <span className="text-xs text-gray-500">{t("printModal.itemsAvailable", { count: counts.articles })}</span>
                </div>
              </div>
              <input 
                type="checkbox" 
                className="hidden" 
                checked={options.articles} 
                onChange={() => setOptions(p => ({ ...p, articles: !p.articles }))}
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/30 cursor-pointer transition-all group">
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  options.annexes ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300 group-hover:border-blue-400"
                }`}>
                  {options.annexes && <Check size={12} className="text-white" />}
                </div>
                <div className="flex flex-col">
                  <span className="font-medium text-gray-900">{t("common.annexes")}</span>
                  <span className="text-xs text-gray-500">{t("printModal.itemsAvailable", { count: counts.annexes })}</span>
                </div>
              </div>
              <input 
                type="checkbox" 
                className="hidden" 
                checked={options.annexes} 
                onChange={() => setOptions(p => ({ ...p, annexes: !p.annexes }))}
              />
            </label>
          </div>

          {/* Advanced Options */}
          {options.articles && (
            <div className="pt-4 border-t border-gray-100">
               <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{t("printModal.layout")}</p>
               
               <label className="flex items-start gap-3 cursor-pointer group">
                  <div className={`w-5 h-5 mt-0.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    options.relatedRecitals ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300 group-hover:border-blue-400"
                  }`}>
                    {options.relatedRecitals && <Check size={12} className="text-white" />}
                  </div>
                  <div className="flex-1">
                    <span className="block text-sm font-medium text-gray-900 group-hover:text-blue-700">
                      {t("printModal.includeRelatedRecitals")}
                    </span>
                    <span className="block text-xs text-gray-500 mt-0.5 leading-relaxed">
                      {t("printModal.includeRelatedRecitalsHelp")}
                    </span>
                  </div>
                  <input 
                    type="checkbox" 
                    className="hidden" 
                    checked={options.relatedRecitals} 
                    onChange={() => setOptions(p => ({ ...p, relatedRecitals: !p.relatedRecitals }))}
                  />
               </label>
            </div>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} className="flex-1 justify-center">
            {t("common.cancel")}
          </Button>
          <Button onClick={handlePrint} className="flex-1 justify-center bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-200">
            {t("printModal.generateView")}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
