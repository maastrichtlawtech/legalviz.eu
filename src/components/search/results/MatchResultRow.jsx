export function MatchResultRow({ item, t }) {
  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-2.5">
        <span className={`flex-shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
          item.type === "article"
            ? "border-blue-100 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
            : item.type === "recital"
              ? "border-purple-100 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
              : "border-orange-100 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-900/40 dark:text-orange-200"
        }`}>
          {item.type}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-base text-gray-900 group-hover:text-eu-blue dark:text-gray-100 dark:group-hover:text-eu-blue-bright">
          {item.title}
        </span>
        {item.score > 100 && (
          <span className="flex-shrink-0 rounded-full bg-green-100 px-1.5 text-[10px] font-medium text-green-700 dark:bg-green-900/50 dark:text-green-200">{t("search.bestMatch")}</span>
        )}
        {item.law_label && (
          <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            {item.law_label}
          </span>
        )}
      </div>
      <p className="pl-1 text-sm leading-relaxed text-gray-500 line-clamp-2 dark:text-gray-300">
        <span className="opacity-70">...</span>
        {item.preview}
        <span className="opacity-70">...</span>
      </p>
    </>
  );
}