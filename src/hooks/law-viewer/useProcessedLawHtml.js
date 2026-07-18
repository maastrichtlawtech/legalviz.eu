import { useMemo } from "react";
import { injectDefinitionTooltips } from "../../utils/definitions.js";
import { sanitizeLawHtml } from "../../utils/sanitizeHtml.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function useProcessedLawHtml({ data, selected, selectedEntry = null, activeDefinitionTerm = "" }) {
  return useMemo(() => {
    let selectedHtml = selectedEntry
      ? selectedEntry.article_html || selectedEntry.recital_html || selectedEntry.annex_html || ""
      : selected.html;

    if (!selectedHtml) return "";

    const recitalTitle = selected.kind === "recital"
      ? String(selectedEntry?.recital_title || "").trim()
      : "";
    if (recitalTitle && !/<p[^>]*class="[^"]*oj-sti-art[^"]*"[^>]*>/i.test(selectedHtml)) {
      selectedHtml = `<p class="oj-sti-art">${escapeHtml(recitalTitle)}</p>${selectedHtml}`;
    }

    const definitionEntry = selected.kind === "article"
      ? selectedEntry || data.articles.find((article) => article.article_number === selected.id)
      : null;
    const skipDefinitions = definitionEntry?.article_title &&
      /definitions?|definicj/i.test(definitionEntry.article_title);

    return sanitizeLawHtml(injectDefinitionTooltips(selectedHtml, data.definitions, {
      skipDefinitionsArticle: skipDefinitions,
      langCode: data.langCode,
      activeTerm: activeDefinitionTerm,
    }));
  }, [activeDefinitionTerm, data.articles, data.definitions, data.langCode, selected, selectedEntry]);
}
