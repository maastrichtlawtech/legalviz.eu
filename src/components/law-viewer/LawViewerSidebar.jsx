import { Menu, X } from "lucide-react";
import { NavigationControls } from "../NavigationControls.jsx";
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
      </div>
    </aside>
  );
}
