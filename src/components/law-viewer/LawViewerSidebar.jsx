import { Loader2, Menu, X } from "lucide-react";
import { NavigationControls } from "../NavigationControls.jsx";
import { Accordion } from "../Accordion.jsx";
import { MetadataPanel, CaseLawButton } from "../MetadataPanel.jsx";
import { LawViewerQuickNavigation } from "./LawViewerQuickNavigation.jsx";
import { LawViewerToc } from "./LawViewerToc.jsx";

export function LawViewerSidebar({
  isSidebarOpen,
  mobileMenuOpen,
  selected,
  data,
  onPrevNext,
  selection,
  loading,
  loadError,
  hasLoadedContent,
  externalLawOverview,
  handleOpenExternalLaw,
  isExternalReferencePending,
  effectiveCelex,
  formexLang,
  isOverview,
  onGoOverview,
  t,
}) {
  return (
    <aside className={`order-1 w-full md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:w-72 md:shrink-0 md:overflow-y-auto transition-all duration-300 ${!isSidebarOpen ? "md:hidden" : ""}`}>
      <div className="mb-4 flex gap-2 md:hidden">
        <button
          type="button"
          onClick={() => selection.setMobileMenuOpen((current) => !current)}
          aria-expanded={mobileMenuOpen}
          aria-label={t("lawViewer.toggleContents")}
          className="flex flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-2 text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          title={t("lawViewer.toggleContents")}
        >
          {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="min-w-0 flex-1">
          <NavigationControls
            selected={selected}
            lists={{ articles: data.articles, recitals: data.recitals, annexes: data.annexes }}
            onPrevNext={onPrevNext}
            className="h-full w-full"
          />
        </div>
      </div>

      <div className={`space-y-4 ${mobileMenuOpen ? "block" : "hidden md:block"}`}>
        <LawViewerQuickNavigation
          selected={selected}
          lists={{ articles: data.articles, recitals: data.recitals, annexes: data.annexes }}
          onPrevNext={onPrevNext}
          selectArticleIdx={selection.selectArticleIdx}
          selectRecitalIdx={selection.selectRecitalIdx}
          selectAnnexIdx={selection.selectAnnexIdx}
          closeMobileMenu={selection.closeMobileMenu}
          t={t}
        />

        <div>
          <div className="mb-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("lawViewer.tableOfContents")}
          </div>
          <LawViewerToc
            loading={loading}
            loadError={loadError}
            hasLoadedContent={hasLoadedContent}
            toc={selection.toc}
            openChapter={selection.openChapter}
            setOpenChapter={selection.setOpenChapter}
            annexes={data.annexes}
            isAnnexesOpen={selection.isAnnexesOpen}
            setIsAnnexesOpen={selection.setIsAnnexesOpen}
            selected={selected}
            onClickArticle={selection.onClickArticle}
            onClickAnnex={(annex) => {
              const index = data.annexes.findIndex((entry) => entry.annex_id === annex.annex_id);
              if (index !== -1) selection.selectAnnexIdx(index);
            }}
            closeMobileMenu={selection.closeMobileMenu}
            isOverview={isOverview}
            onGoOverview={onGoOverview}
            t={t}
          />
        </div>

        <div className="space-y-4 border-t border-gray-100 pt-4 dark:border-gray-800">
          <CaseLawButton celex={effectiveCelex} currentLang={formexLang} />

          {externalLawOverview.length > 0 ? (
            <Accordion title={`Linked Legislation (${externalLawOverview.length})`} defaultOpen={false}>
              <div className="flex flex-wrap gap-2">
                {externalLawOverview.map((item) => {
                  const pending = typeof isExternalReferencePending === "function"
                    ? isExternalReferencePending(item.ref)
                    : false;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      disabled={pending}
                      onClick={() => handleOpenExternalLaw(item.ref)}
                      className={`inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900 transition dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100 ${
                        pending
                          ? "cursor-progress border-blue-400 bg-blue-100 dark:border-blue-700 dark:bg-blue-950/70"
                          : "hover:border-blue-400 hover:bg-blue-100 dark:hover:border-blue-700 dark:hover:bg-blue-950/70"
                      }`}
                    >
                      {pending ? <Loader2 size={12} className="animate-spin" /> : null}
                      <span className="max-w-[220px] truncate">{item.label}</span>
                      <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/70 dark:text-blue-200">
                        {item.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Accordion>
          ) : null}

          <MetadataPanel celex={effectiveCelex} currentLang={formexLang} />
        </div>
      </div>
    </aside>
  );
}
