import { Fragment, useMemo } from "react";
import { X } from "lucide-react";
import { EU_LANGUAGES } from "../../utils/formexApi.js";
import { alignHtmlBlocks } from "../../utils/law-viewer/alignBlocks.js";
import { LanguageSelector } from "../LanguageSelector.jsx";
import { LawContentPane } from "./LawContentPane.jsx";
import { LawDocumentContent } from "./LawDocumentContent.jsx";

export function LawViewerSideBySide({
  isSideBySide,
  secondaryLang,
  setSecondaryLanguage,
  hasCelex,
  formexLang,
  selected,
  secondaryLoading,
  secondaryLoadError,
  secondaryProcessedHtml,
  processedHtml,
  handleContentClick,
  getProseClass,
  getTextClass,
  fontScale,
  isResolvingExternalLaw,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  t,
}) {
  // Aligned rows are display-only: the two parser-produced HTML strings are
  // re-sliced into top-level blocks and paired by index. Anything degenerate
  // (loading, error, a missing side, or a single block) falls back to the
  // classic two-pane layout below.
  const alignedRows = useMemo(
    () =>
      isSideBySide && processedHtml && secondaryProcessedHtml
        ? alignHtmlBlocks(processedHtml, secondaryProcessedHtml)
        : [],
    [isSideBySide, processedHtml, secondaryProcessedHtml]
  );
  const isAligned =
    alignedRows.length > 1 && !secondaryLoading && !secondaryLoadError;

  if (!isSideBySide) {
    return (
      <LawDocumentContent
        processedHtml={processedHtml}
        fontScale={fontScale}
        getProseClass={getProseClass}
        getTextClass={getTextClass}
        onContentClick={handleContentClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        isResolvingExternalLaw={isResolvingExternalLaw}
        t={t}
      />
    );
  }

  const primaryName = EU_LANGUAGES[formexLang] || formexLang;
  const secondaryName = EU_LANGUAGES[secondaryLang] || secondaryLang;

  const secondaryLanguageSelector = (
    <LanguageSelector
      currentLang={secondaryLang}
      onChangeLang={setSecondaryLanguage}
      hasCelex={hasCelex}
      label={t("lawViewer.secondaryLanguage")}
      excludeLanguages={[formexLang]}
      align="right"
      showCode={false}
    />
  );

  const closeButton = (
    <button
      type="button"
      onClick={() => setSecondaryLanguage(null)}
      className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      title={t("topBar.closeSideBySide")}
      aria-label={t("topBar.closeSideBySide")}
    >
      <X size={16} />
    </button>
  );

  return (
    <>
      <div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 xl:hidden dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
        {t("lawViewer.sideBySideDesktopOnly")}
      </div>
      <div className="space-y-6 xl:hidden">
        <LawDocumentContent
          processedHtml={processedHtml}
          fontScale={fontScale}
          getProseClass={getProseClass}
          getTextClass={getTextClass}
          onContentClick={handleContentClick}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          isResolvingExternalLaw={isResolvingExternalLaw}
          t={t}
        />
      </div>

      {isAligned ? (
        <div className="hidden rounded-2xl border border-gray-200 bg-white p-6 shadow-sm xl:block dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="flex items-center overflow-hidden rounded-lg border border-gray-200 text-[12.5px] dark:border-gray-700">
              <span className="bg-eu-blue-soft px-3 py-1.5 font-semibold text-eu-blue dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright">
                {primaryName}
              </span>
              <span className="border-l border-gray-200 bg-eu-blue-soft px-3 py-1.5 font-semibold text-eu-blue dark:border-gray-700 dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright">
                {secondaryName}
              </span>
            </div>
            {secondaryLanguageSelector}
            <span className="text-[11.5px] text-gray-400 dark:text-gray-500">
              {t("lawViewer.alignedByParagraph")}
            </span>
            <div className="ml-auto">{closeButton}</div>
          </div>
          <article
            className={`prose prose-slate ${getProseClass(fontScale)} ${getTextClass(fontScale)} max-w-none transition-all duration-200 ${isResolvingExternalLaw ? "cursor-progress" : ""}`}
            onClick={handleContentClick}
          >
            <div className="grid grid-cols-2 items-start gap-x-10">
              <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {primaryName}
              </div>
              <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {secondaryName}
              </div>
              {alignedRows.map((row, index) => (
                <Fragment key={index}>
                  <div
                    className="min-w-0"
                    dangerouslySetInnerHTML={{ __html: row.a || "" }}
                  />
                  <div
                    className="min-w-0"
                    dangerouslySetInnerHTML={{ __html: row.b || "" }}
                  />
                </Fragment>
              ))}
            </div>
          </article>
        </div>
      ) : (
        <div className="hidden gap-6 xl:grid xl:grid-cols-2">
          <LawContentPane
            label={t("lawViewer.primaryLanguage")}
            lang={formexLang}
            hasCelex={hasCelex}
            selected={selected}
            loading={false}
            loadError={null}
            processedHtml={processedHtml}
            onContentClick={handleContentClick}
            getProseClass={getProseClass}
            getTextClass={getTextClass}
            fontScale={fontScale}
            isResolvingExternalLaw={isResolvingExternalLaw}
            t={t}
          />
          <LawContentPane
            label={t("lawViewer.secondaryLanguage")}
            lang={secondaryLang}
            hasCelex={hasCelex}
            selected={selected}
            loading={secondaryLoading}
            loadError={secondaryLoadError}
            processedHtml={secondaryProcessedHtml}
            onContentClick={handleContentClick}
            getProseClass={getProseClass}
            getTextClass={getTextClass}
            fontScale={fontScale}
            isResolvingExternalLaw={isResolvingExternalLaw}
            t={t}
            selector={secondaryLanguageSelector}
            emptyMessage={t("lawViewer.selectPrompt")}
            onClose={() => setSecondaryLanguage(null)}
          />
        </div>
      )}
    </>
  );
}
