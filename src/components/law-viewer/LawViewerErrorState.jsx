import { Info, RefreshCw } from "lucide-react";
import { Button } from "../Button.jsx";

export function LawViewerErrorState({ loadError, externalFallbackUrl, retryLoad, t }) {
  const tone = loadError?.tone === "notice" ? "notice" : "error";
  const panelClass = tone === "notice"
    ? "border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/20"
    : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30";
  const titleClass = tone === "notice"
    ? "text-sky-950 dark:text-sky-100"
    : "text-red-900 dark:text-red-200";
  const bodyClass = tone === "notice"
    ? "text-sky-900 dark:text-sky-200"
    : "text-red-700 dark:text-red-300";

  return (
    <div className="flex min-h-[30vh] flex-col items-center justify-center text-center">
      <div className={`rounded-2xl border px-6 py-8 ${panelClass}`}>
        <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
          tone === "notice"
            ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200"
            : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-200"
        }`}>
          <Info size={22} />
        </div>
        <h2 className={`mt-4 text-2xl font-bold font-serif ${titleClass}`}>{loadError.title}</h2>
        <p className={`mt-3 max-w-xl text-sm leading-6 ${bodyClass}`}>{loadError.message}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {externalFallbackUrl ? (
            <Button
              type="button"
              className={tone === "notice" ? "border border-sky-700 bg-sky-700 text-white hover:bg-sky-800 dark:border-sky-300 dark:bg-sky-300 dark:text-sky-950 dark:hover:bg-sky-200" : ""}
              onClick={() => window.open(externalFallbackUrl, "_blank", "noopener,noreferrer")}
            >
              {t("common.openOnEurlex")}
            </Button>
          ) : null}
          {retryLoad ? (
            <Button
              type="button"
              variant="outline"
              className={tone === "notice" ? "border-sky-200 bg-white text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/10 dark:text-sky-100 dark:hover:bg-sky-900/30" : ""}
              onClick={retryLoad}
            >
              <RefreshCw size={16} />
              {t("common.reloadPage")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
