import React, { useMemo } from "react";
import { mapRecitalsToArticles } from "../utils/nlp.js";

export function PrintView({ data, options, uiLocale = "en", labels }) {
  const { title, articles, recitals, annexes } = data ?? {};
  const {
    recitals: includeRecitals,
    articles: includeArticles,
    annexes: includeAnnexes,
    relatedRecitals: includeRelatedRecitals,
  } = options ?? {};

  // Compute related recitals if needed.
  const relatedRecitalsMap = useMemo(() => {
    if (!includeRelatedRecitals || !articles || !recitals) return new Map();
    return mapRecitalsToArticles(recitals, articles, data?.langCode);
  }, [includeRelatedRecitals, articles, recitals, data?.langCode]);

  if (!data) return null;

  // Helper to render division headers (Chapter/Section)
  let lastChapter = null;
  let lastSection = null;

  const renderArticleWithDivisions = (article, index) => {
    const divs = [];
    const ch = article.division?.chapter;
    const sec = article.division?.section;

    const chLabel = ch ? [ch.number, ch.title].filter(Boolean).join(" — ") : null;
    const secLabel = sec ? [sec.number, sec.title].filter(Boolean).join(" — ") : null;

    if (chLabel && chLabel !== lastChapter) {
      divs.push(
        <div key={`ch-${index}`} className="break-inside-avoid mt-6 mb-2">
          <h3 className="text-lg font-bold font-serif text-gray-900 uppercase tracking-wide border-b border-gray-900 pb-1">
            {chLabel}
          </h3>
        </div>
      );
      lastChapter = chLabel;
      // Reset section when chapter changes
      lastSection = null;
    }

    if (secLabel && secLabel !== lastSection) {
      divs.push(
        <div key={`sec-${index}`} className="break-inside-avoid mt-4 mb-2">
          <h4 className="text-base font-bold font-serif text-gray-800 uppercase tracking-wide">
            {secLabel}
          </h4>
        </div>
      );
      lastSection = secLabel;
    }

    const articleRecitals = relatedRecitalsMap.get(article.article_number) || [];

    return (
      <React.Fragment key={article.article_number}>
        {divs}
        <div className="article-block mb-4">
          <h5 className="font-bold text-gray-900 mb-1 text-sm break-after-avoid">
            {labels.article} {article.article_number}
            {article.article_title && <span className="font-normal text-gray-600 ml-2">— {article.article_title}</span>}
          </h5>
          <div
            className="prose prose-sm prose-slate max-w-none text-justify print-content"
            dangerouslySetInnerHTML={{ __html: article.article_html }}
          />

          {/* Render Related Recitals */}
          {articleRecitals.length > 0 && (
            <div className="mt-4 mb-6 pl-4 border-l-2 border-gray-200 bg-gray-50/50 rounded-r-lg py-2">
              <h6 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">{labels.relatedRecitals}</h6>
              <div className="space-y-3">
                {articleRecitals.map(r => (
                  <div key={r.recital_number} className="flex gap-2">
                    <span className="font-bold text-[10px] text-gray-400 shrink-0 mt-0.5">({r.recital_number})</span>
                    <div 
                      className="prose prose-xs prose-slate max-w-none text-justify print-content text-gray-600"
                      dangerouslySetInnerHTML={{ __html: r.recital_html }} 
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </React.Fragment>
    );
  };

  return (
    <div className="max-w-[210mm] mx-auto bg-white p-8 md:p-12 print:p-4">
      {/* Title */}
      <header className="mb-6 text-center border-b border-gray-900 pb-4">
        <h1 className="text-2xl font-bold font-serif text-gray-900 mb-2 leading-tight">
          {title || labels.documentTitle}
        </h1>
        <p className="text-xs text-gray-500">
          {labels.generatedOn.replace("{date}", new Date().toLocaleString(uiLocale))}
        </p>
        <p className="text-xs text-gray-500">
          Built by <a href="https://kollnig.net" className="underline">Konrad Kollnig</a> at the <a href="https://www.maastrichtuniversity.nl/law-tech-lab" className="underline">Law & Tech Lab</a>, Maastricht University.
        </p>
      </header>

      {/* Recitals */}
      {includeRecitals && recitals?.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold font-serif text-gray-900 mb-4 border-b border-gray-200 pb-1">
            {labels.recitals}
          </h2>
          <div className="space-y-2">
            {recitals.map((r) => (
              <div key={r.recital_number} className="">
                 <div className="flex gap-3">
                    <span className="font-bold text-xs text-gray-500 shrink-0 mt-0.5">({r.recital_number})</span>
                    <div 
                      className="prose prose-xs prose-slate max-w-none text-justify print-content"
                      dangerouslySetInnerHTML={{ __html: r.recital_html }} 
                    />
                 </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Articles */}
      {includeArticles && articles?.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold font-serif text-gray-900 mb-4 border-b border-gray-200 pb-1">
            {labels.articles}
          </h2>
          <div>
            {articles.map((a, i) => renderArticleWithDivisions(a, i))}
          </div>
        </section>
      )}

      {/* Annexes */}
      {includeAnnexes && annexes?.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold font-serif text-gray-900 mb-4 border-b border-gray-200 pb-1">
            {labels.annexes}
          </h2>
          <div className="space-y-6">
            {annexes.map((ax) => (
              <div key={ax.annex_id} className="">
                <h3 className="text-base font-bold text-gray-900 mb-2 break-after-avoid">
                  {ax.annex_title}
                </h3>
                <div
                  className="prose prose-sm prose-slate max-w-none print-content"
                  dangerouslySetInnerHTML={{ __html: ax.annex_html }}
                />
              </div>
            ))}
          </div>
        </section>
      )}
      
      <footer className="mt-8 pt-4 border-t border-gray-200 text-center text-[10px] text-gray-400">
        <p>{labels.printedFrom}</p>
        <p className="mt-1">
          Built by <a href="https://kollnig.net" className="underline">Konrad Kollnig</a> at the <a href="https://www.maastrichtuniversity.nl/law-tech-lab" className="underline">Law & Tech Lab</a>, Maastricht University.
        </p>
      </footer>
    </div>
  );
}
