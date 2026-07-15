import { Home, Menu, X } from "lucide-react";
import { NavigationControls } from "../NavigationControls.jsx";
import { LawViewerQuickNavigation } from "./LawViewerQuickNavigation.jsx";
import { LawViewerToc } from "./LawViewerToc.jsx";
import {
  getChapterMarker,
  sentenceCaseTitle,
  splitChapterLabel,
} from "../../utils/law-viewer/tocFormat.js";

function chapterContainsSelection(chapter, selected) {
  if (selected.kind !== "article") return false;
  const matches = (article) => article.article_number === selected.id;
  if ((chapter.items || []).some(matches)) return true;
  return (chapter.sections || []).some((section) => (section.items || []).some(matches));
}

// Slim chapter strip shown instead of the full rail while parallel-language
// reading is active on xl screens: home + one marker per chapter, the active
// chapter in gold. Clicking a marker jumps to the chapter's first article.
function CollapsedRail({ selection, selected, isOverview, onGoOverview, t }) {
  return (
    <aside className="order-1 hidden w-14 shrink-0 xl:sticky xl:top-20 xl:block xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">
      <div className="flex flex-col items-center gap-1 rounded-2xl border border-gray-200 bg-white py-3 dark:border-gray-800 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => onGoOverview?.()}
          title={t("lawViewer.overviewRow")}
          aria-label={t("lawViewer.overviewRow")}
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
            isOverview
              ? "bg-eu-blue-soft text-eu-blue dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright"
              : "text-gray-400 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800/60 dark:hover:text-gray-200"
          }`}
        >
          <Home size={15} />
        </button>
        {(selection.toc || []).map((chapter) => {
          const marker = getChapterMarker(chapter.label);
          if (!marker) return null;
          const isActive = chapterContainsSelection(chapter, selected);
          const firstArticle =
            chapter.items?.[0] || chapter.sections?.[0]?.items?.[0] || null;
          const title = sentenceCaseTitle(splitChapterLabel(chapter.label).title);
          return (
            <button
              key={chapter.label}
              type="button"
              onClick={() => {
                if (firstArticle) selection.onClickArticle(firstArticle);
              }}
              title={title}
              aria-label={title}
              className={`flex h-8 w-8 items-center justify-center rounded-lg font-serif text-xs italic transition-colors ${
                isActive
                  ? "bg-eu-gold-soft font-semibold text-eu-gold-deep dark:bg-eu-gold-soft-dark dark:text-eu-gold-bright"
                  : "text-gray-400 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800/60 dark:hover:text-gray-200"
              }`}
            >
              {marker}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

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
  collapsed = false,
  t,
}) {
  if (collapsed) {
    return (
      <>
        <CollapsedRail
          selection={selection}
          selected={selected}
          isOverview={isOverview}
          onGoOverview={onGoOverview}
          t={t}
        />
        <FullRail
          isSidebarOpen={isSidebarOpen}
          mobileMenuOpen={mobileMenuOpen}
          selected={selected}
          data={data}
          onPrevNext={onPrevNext}
          selection={selection}
          loading={loading}
          loadError={loadError}
          hasLoadedContent={hasLoadedContent}
          isOverview={isOverview}
          onGoOverview={onGoOverview}
          hiddenOnXl
          t={t}
        />
      </>
    );
  }

  return (
    <FullRail
      isSidebarOpen={isSidebarOpen}
      mobileMenuOpen={mobileMenuOpen}
      selected={selected}
      data={data}
      onPrevNext={onPrevNext}
      selection={selection}
      loading={loading}
      loadError={loadError}
      hasLoadedContent={hasLoadedContent}
      isOverview={isOverview}
      onGoOverview={onGoOverview}
      t={t}
    />
  );
}

function FullRail({
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
  hiddenOnXl = false,
  t,
}) {
  return (
    <aside className={`order-1 w-full md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:w-72 md:shrink-0 md:overflow-y-auto transition-all duration-300 ${!isSidebarOpen ? "md:hidden" : ""} ${hiddenOnXl ? "xl:hidden" : ""}`}>
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
