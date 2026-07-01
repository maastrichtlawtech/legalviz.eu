import { BookOpen } from "lucide-react";
import { Button } from "../Button.jsx";
import { LawSummary } from "../LawSummary.jsx";

function StatChip({ count, label }) {
  if (!count) return null;
  return (
    <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {count} {label}
    </span>
  );
}

export function LawOverviewPage({
  currentLaw,
  data,
  effectiveCelex,
  formexLang,
  onArticleClick,
  onStartReading,
  t,
}) {
  const title = data.title || currentLaw?.label || "";

  return (
    <div>
      <h1 className="mb-3 font-serif text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
        {title}
      </h1>

      <div className="mb-6 flex flex-wrap gap-2">
        <StatChip count={data.articles?.length || 0} label={t("common.articles")} />
        <StatChip count={data.recitals?.length || 0} label={t("common.recitals")} />
        <StatChip count={data.annexes?.length || 0} label={t("common.annexes")} />
      </div>

      <Button type="button" onClick={onStartReading} className="mb-6">
        <BookOpen size={16} />
        {t("lawViewer.startReading")}
      </Button>

      <LawSummary celex={effectiveCelex} lang={formexLang} onArticleClick={onArticleClick} />
    </div>
  );
}
