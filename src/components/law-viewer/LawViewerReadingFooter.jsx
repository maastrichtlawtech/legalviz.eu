import { ArrowLeft, ArrowRight } from "lucide-react";

function getListAndIndex(selected, lists) {
  if (selected.kind === "article") {
    const list = lists.articles || [];
    return { list, index: list.findIndex((a) => a.article_number === selected.id), kind: "article" };
  }
  if (selected.kind === "recital") {
    const list = lists.recitals || [];
    return { list, index: list.findIndex((r) => r.recital_number === selected.id), kind: "recital" };
  }
  if (selected.kind === "annex") {
    const list = lists.annexes || [];
    return { list, index: list.findIndex((x) => x.annex_id === selected.id), kind: "annex" };
  }
  return { list: [], index: -1, kind: null };
}

function shortLabel(entry, kind, t) {
  if (!entry) return "";
  if (kind === "article") return `${t("lawViewer.artShort")} ${entry.article_number}`;
  if (kind === "recital") return `${t("common.recital")} ${entry.recital_number}`;
  return `${t("common.annex")} ${entry.annex_id}`;
}

export function LawViewerReadingFooter({ selected, lists, onPrevNext, onGoOverview, t }) {
  const { list, index, kind } = getListAndIndex(selected, lists);
  if (!kind || index === -1 || list.length === 0) return null;

  const position = index + 1;
  const total = list.length;
  const progress = Math.max(2, Math.round((position / total) * 100));
  const prevEntry = index > 0 ? list[index - 1] : null;
  const nextEntry = index < total - 1 ? list[index + 1] : null;
  const isFirstArticle = kind === "article" && index === 0;
  const nextTitle = nextEntry?.article_title || "";

  return (
    <div className="mt-8 flex items-center gap-4 border-t border-gray-200 pt-5 dark:border-gray-800">
      <div className="min-w-0 flex-1 text-left">
        {isFirstArticle ? (
          <button
            type="button"
            onClick={onGoOverview}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-eu-blue transition-opacity hover:opacity-80 dark:text-eu-blue-bright"
          >
            <ArrowLeft size={14} />
            {t("lawViewer.footerOverview")}
          </button>
        ) : prevEntry ? (
          <button
            type="button"
            onClick={() => onPrevNext(kind, index - 1)}
            className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ArrowLeft size={14} className="shrink-0" />
            <span className="truncate">{t("lawViewer.footerPrevious")}</span>
          </button>
        ) : null}
      </div>

      <div className="w-40 shrink-0 sm:w-52">
        <div className="mb-1.5 text-center text-[11px] text-gray-400 dark:text-gray-500">
          {t("lawViewer.footerProgress", { position, total })}
          <span className="mx-1.5 text-gray-300 dark:text-gray-600">·</span>
          {t("lawViewer.footerKeys")}
        </div>
        <div className="h-[3px] overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div className="h-full rounded-full bg-eu-gold" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="min-w-0 flex-1 text-right">
        {nextEntry ? (
          <button
            type="button"
            onClick={() => onPrevNext(kind, index + 1)}
            className="inline-flex max-w-full items-center justify-end gap-1.5 truncate text-sm font-medium text-eu-blue transition-opacity hover:opacity-80 dark:text-eu-blue-bright"
          >
            <span className="truncate">
              {t("lawViewer.footerNext", { label: shortLabel(nextEntry, kind, t) })}
              {nextTitle ? <span className="font-normal text-gray-400 dark:text-gray-500"> — {nextTitle}</span> : null}
            </span>
            <ArrowRight size={14} className="shrink-0" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
