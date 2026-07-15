import { ChevronRight, Home } from "lucide-react";
import { getAnnexSidebarTitle } from "../../utils/law-viewer/content.js";
import {
  getChapterArticleRange,
  getChapterMarker,
  sentenceCaseTitle,
  splitChapterLabel,
} from "../../utils/law-viewer/tocFormat.js";

function ChapterMarker({ label }) {
  const marker = getChapterMarker(label);
  if (!marker) return <span className="w-5 shrink-0" aria-hidden="true" />;
  return (
    <span className="w-5 shrink-0 text-right font-serif text-xs italic text-eu-gold-deep dark:text-eu-gold-bright">
      {marker}
    </span>
  );
}

function ArticleRow({ article, selected, onSelect }) {
  const isActive = selected.kind === "article" && selected.id === article.article_number;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`relative flex w-full items-baseline gap-1.5 rounded-md py-1.5 pl-3 pr-2 text-left text-[13px] transition-colors ${
          isActive
            ? "font-medium text-eu-blue before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-eu-gold dark:text-eu-blue-bright"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-200"
        }`}
      >
        <span className="shrink-0 font-medium">
          {article.display_label || `Art. ${article.article_number}`}
        </span>
        {article.article_title ? (
          <span className={`min-w-0 flex-1 truncate ${isActive ? "" : "text-gray-400 dark:text-gray-500"}`}>
            · {article.article_title}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ArticleList({ articles, selected, onClickArticle, closeMobileMenu }) {
  return (
    <ul className="mt-0.5 space-y-0.5">
      {articles.map((article) => (
        <ArticleRow
          key={`toc-${article.article_number}`}
          article={article}
          selected={selected}
          onSelect={() => {
            onClickArticle(article);
            closeMobileMenu();
          }}
        />
      ))}
    </ul>
  );
}

export function LawViewerToc({
  loading,
  loadError,
  hasLoadedContent,
  toc,
  openChapter,
  setOpenChapter,
  annexes,
  isAnnexesOpen,
  setIsAnnexesOpen,
  selected,
  onClickArticle,
  onClickAnnex,
  closeMobileMenu,
  isOverview,
  onGoOverview,
  t,
}) {
  const loadErrorTone = loadError?.tone === "notice" ? "notice" : "error";

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        {t("lawViewer.loadingLaw")}
      </div>
    );
  }

  if (loadError && !hasLoadedContent) {
    return (
      <div className={`rounded-2xl border p-4 text-sm ${
        loadErrorTone === "notice"
          ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-200"
          : "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
      }`}>
        {loadErrorTone === "notice"
          ? t("lawViewer.structuredVersionUnavailable")
          : t("lawViewer.lawContentUnavailable")}
      </div>
    );
  }

  if (!toc.length && !annexes?.length) {
    return <div className="p-4 text-center text-sm text-gray-500">{t("lawViewer.noArticles")}</div>;
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => {
          onGoOverview?.();
          closeMobileMenu();
        }}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors ${
          isOverview
            ? "bg-eu-blue-soft font-medium text-eu-blue dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright"
            : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800/60 dark:hover:text-gray-100"
        }`}
      >
        <Home size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("lawViewer.overviewRow")}</span>
      </button>

      {toc.map((chapter) => {
        const { marker, title } = splitChapterLabel(chapter.label);
        const isUntitled = !marker && (!title || title === "(Untitled Chapter)");
        const range = getChapterArticleRange(chapter);
        const isOpen = openChapter === chapter.label;
        const hasChildren = (chapter.items?.length || 0) > 0 || (chapter.sections?.length || 0) > 0;

        // Chapterless laws (a single "(Untitled Chapter)" bucket) render their
        // articles flat, without a shouting placeholder header.
        if (isUntitled) {
          return (
            <div key={chapter.label}>
              <ArticleList
                articles={chapter.items || []}
                selected={selected}
                onClickArticle={onClickArticle}
                closeMobileMenu={closeMobileMenu}
              />
            </div>
          );
        }

        return (
          <div key={chapter.label}>
            <button
              type="button"
              onClick={() => setOpenChapter(isOpen ? null : chapter.label)}
              aria-expanded={isOpen}
              className="group flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-[13px] text-gray-800 transition-colors hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800/60"
            >
              <ChapterMarker label={chapter.label} />
              <span className={`min-w-0 flex-1 leading-snug ${isOpen ? "font-semibold" : ""}`}>
                {sentenceCaseTitle(title)}
              </span>
              {range ? (
                <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                  {t("lawViewer.articleRange", { range })}
                </span>
              ) : hasChildren ? (
                <ChevronRight
                  size={13}
                  className={`shrink-0 text-gray-400 transition-transform dark:text-gray-500 ${isOpen ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
              ) : null}
            </button>

            {isOpen ? (
              <div className="pb-1 pl-5">
                {chapter.items?.length > 0 ? (
                  <ArticleList
                    articles={chapter.items}
                    selected={selected}
                    onClickArticle={onClickArticle}
                    closeMobileMenu={closeMobileMenu}
                  />
                ) : null}
                {chapter.sections?.map((section) => (
                  <div key={section.label} className="mt-2">
                    <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">
                      {sentenceCaseTitle(splitChapterLabel(section.label).title || section.label)}
                    </div>
                    <ArticleList
                      articles={section.items}
                      selected={selected}
                      onClickArticle={onClickArticle}
                      closeMobileMenu={closeMobileMenu}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {annexes?.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setIsAnnexesOpen((current) => !current)}
            aria-expanded={isAnnexesOpen}
            className="flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-[13px] text-gray-800 transition-colors hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800/60"
          >
            <span className="w-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 leading-snug">{t("common.annexes")}</span>
            <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{annexes.length}</span>
          </button>
          {isAnnexesOpen ? (
            <ul className="space-y-0.5 pb-1 pl-5">
              {annexes.map((annex) => {
                const annexSidebarTitle = getAnnexSidebarTitle(annex);
                const isActive = selected.kind === "annex" && selected.id === annex.annex_id;
                return (
                  <li key={`toc-annex-${annex.annex_id}`}>
                    <button
                      type="button"
                      onClick={() => {
                        onClickAnnex(annex);
                        closeMobileMenu();
                      }}
                      className={`relative flex w-full items-baseline gap-1.5 rounded-md py-1.5 pl-3 pr-2 text-left text-[13px] transition-colors ${
                        isActive
                          ? "font-medium text-eu-blue before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-eu-gold dark:text-eu-blue-bright"
                          : "text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-200"
                      }`}
                    >
                      <span className="shrink-0 font-medium">{t("common.annex")} {annex.annex_id}</span>
                      {annexSidebarTitle ? (
                        <span className={`min-w-0 flex-1 truncate ${isActive ? "" : "text-gray-400 dark:text-gray-500"}`}>
                          · {annexSidebarTitle}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
