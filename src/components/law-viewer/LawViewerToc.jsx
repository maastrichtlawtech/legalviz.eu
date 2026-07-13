import { Accordion } from "../Accordion.jsx";
import { Button } from "../Button.jsx";
import { getAnnexSidebarTitle } from "../../utils/law-viewer/content.js";

function ArticleTocButton({ article, selected, onClick }) {
  return (
    <Button
      variant="ghost"
      className={`w-full justify-start text-left ${
        selected.kind === "article" && selected.id === article.article_number ? "bg-blue-50 text-blue-700" : ""
      }`}
      onClick={onClick}
    >
      <span className="w-full truncate text-left">
        <span className="font-medium">{article.display_label || `Art. ${article.article_number}`}</span>
        {article.article_title ? (
          <span className="ml-1 font-normal text-gray-500 opacity-80 dark:text-gray-400 dark:opacity-100">
            - {article.article_title}
          </span>
        ) : null}
      </span>
    </Button>
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
    <div className="space-y-2">
      {toc.map((chapter) => {
        const isOpen = openChapter === chapter.label;
        return (
          <Accordion
            key={chapter.label}
            title={chapter.label || "(Untitled Chapter)"}
            isOpen={isOpen}
            onToggle={() => setOpenChapter(isOpen ? null : chapter.label)}
          >
            {chapter.items?.length > 0 ? (
              <ul className="space-y-1">
                {chapter.items.map((article) => (
                  <li key={`toc-${article.article_number}`}>
                    <ArticleTocButton
                      article={article}
                      selected={selected}
                      onClick={() => {
                        onClickArticle(article);
                        closeMobileMenu();
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {chapter.sections?.map((section) => (
              <div key={section.label} className="mt-3">
                <div className="border-t border-gray-100 px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  {section.label}
                </div>
                <ul className="space-y-1">
                  {section.items.map((article) => (
                    <li key={`toc-${article.article_number}`}>
                      <ArticleTocButton
                        article={article}
                        selected={selected}
                        onClick={() => {
                          onClickArticle(article);
                          closeMobileMenu();
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Accordion>
        );
      })}

      {annexes?.length > 0 ? (
        <Accordion
          title={`${t("common.annexes")} (${annexes.length})`}
          isOpen={isAnnexesOpen}
          onToggle={() => setIsAnnexesOpen((current) => !current)}
        >
          <ul className="space-y-1">
            {annexes.map((annex) => {
              const annexSidebarTitle = getAnnexSidebarTitle(annex);
              return (
                <li key={`toc-annex-${annex.annex_id}`}>
                  <Button
                    variant="ghost"
                    className={`w-full justify-start text-left ${
                      selected.kind === "annex" && selected.id === annex.annex_id ? "bg-blue-50 text-blue-700" : ""
                    }`}
                    onClick={() => {
                      onClickAnnex(annex);
                      closeMobileMenu();
                    }}
                  >
                    <span className="w-full truncate text-left">
                      <span className="font-medium">{t("common.annex")} {annex.annex_id}</span>
                      {annexSidebarTitle ? (
                        <span className="ml-1 font-normal text-gray-500 opacity-80 dark:text-gray-400 dark:opacity-100">
                          - {annexSidebarTitle}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </Accordion>
      ) : null}
    </div>
  );
}
