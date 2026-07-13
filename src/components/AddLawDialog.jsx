import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function AddLawDialog({
  isOpen,
  onClose,
  referenceType,
  setReferenceType,
  referenceYear,
  setReferenceYear,
  referenceNumber,
  setReferenceNumber,
  handleReferenceImport,
  isImporting,
  importError,
  eurlexUrl,
  setEurlexUrl,
  handleEurlexUrlImport,
  isResolvingUrl,
  eurlexError,
  t,
}) {
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center bg-black/40 p-0 backdrop-blur-sm md:p-6 md:pt-[10vh]">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-law-dialog-title"
        className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl ring-1 ring-black/5 md:h-auto md:max-h-[80vh] md:rounded-3xl dark:bg-gray-900 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-5 dark:border-gray-800">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
              {t("landing.addLawDialogEyebrow")}
            </p>
            <h2 id="add-law-dialog-title" className="mt-2 text-xl font-semibold text-gray-900 dark:text-white">
              {t("landing.addLawDialogTitle")}
            </h2>
            <p className="mt-2 max-w-xl text-sm text-gray-600 dark:text-gray-400">
              {t("landing.addLawDialogDescription")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-5">
            <div>
              <p className="mb-3 text-sm font-medium text-gray-900 dark:text-white">{t("landing.addByReferenceTitle")}</p>
              <form onSubmit={handleReferenceImport} className="grid gap-3 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
                <select
                  value={referenceType}
                  onChange={(e) => setReferenceType(e.target.value)}
                  className="min-w-0 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
                >
                  <option value="regulation">{t("landing.regulation")}</option>
                  <option value="directive">{t("landing.directive")}</option>
                  <option value="decision">{t("landing.decision")}</option>
                </select>
                <input
                  type="text"
                  inputMode="numeric"
                  value={referenceYear}
                  onChange={(e) => setReferenceYear(e.target.value)}
                  placeholder={t("landing.year")}
                  className="min-w-0 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder={t("landing.number")}
                  className="min-w-0 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
                />
                <button
                  type="submit"
                  disabled={isImporting}
                  className="rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  {isImporting ? t("landing.addingLaw") : t("landing.addLawSubmit")}
                </button>
              </form>
              {importError ? (
                <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  {importError}
                </p>
              ) : null}
            </div>

            <div className="border-t border-gray-100 pt-5 dark:border-gray-800">
              <p className="mb-3 text-sm font-medium text-gray-900 dark:text-white">{t("landing.pasteEurlexUrlTitle")}</p>
              <form onSubmit={handleEurlexUrlImport} className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="url"
                  value={eurlexUrl}
                  onChange={(e) => setEurlexUrl(e.target.value)}
                  placeholder="https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng"
                  className="min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
                />
                <button
                  type="submit"
                  disabled={isResolvingUrl}
                  className="rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  {isResolvingUrl ? t("landing.addingLaw") : t("landing.addFromUrl")}
                </button>
              </form>
              {eurlexError ? (
                <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  {eurlexError}
                </p>
              ) : null}
            </div>

            <div className="border-t border-gray-100 pt-5 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">
              <p>
                {t("landing.extensionInline")}{" "}
                <a
                  href="https://chrome.google.com/webstore/detail/eur-lex-visualiser/akkfdjadggheloggnfonppfkbifanpbc"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-200"
                >
                  Chrome
                </a>
                {", "}
                <a
                  href="https://chrome.google.com/webstore/detail/eur-lex-visualiser/akkfdjadggheloggnfonppfkbifanpbc"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-200"
                >
                  Brave
                </a>
                {", "}
                <a
                  href="https://chrome.google.com/webstore/detail/eur-lex-visualiser/akkfdjadggheloggnfonppfkbifanpbc"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-200"
                >
                  Edge
                </a>
                {t("landing.orConjunction")}
                <a
                  href="https://addons.mozilla.org/en-US/firefox/addon/eur-lex-visualiser/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-200"
                >
                  Firefox
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
