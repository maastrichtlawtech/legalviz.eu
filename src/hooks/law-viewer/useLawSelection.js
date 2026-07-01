import { useCallback, useEffect, useMemo, useState } from "react";
import { buildToc } from "../../utils/law-viewer/content.js";
import { resolveSelectionFromData } from "../../utils/law-viewer/selection.js";

export function useLawSelection({ data, kind, id, navigateToCanonical }) {
  const [selected, setSelected] = useState({ kind: "overview", id: null, html: "" });
  const [openChapter, setOpenChapter] = useState(null);
  const [isAnnexesOpen, setIsAnnexesOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const toc = useMemo(() => buildToc(data.articles), [data.articles]);

  useEffect(() => {
    if (!data.articles?.length && !data.recitals?.length && !data.annexes?.length) return;

    const nextSelection = resolveSelectionFromData(data, kind, id);
    if (!nextSelection) return;

    setSelected(nextSelection);

    if (!kind || !id || nextSelection.kind !== kind || String(nextSelection.id) !== String(id)) {
      navigateToCanonical(nextSelection.kind, nextSelection.id, { replace: true });
    }
  }, [data, id, kind, navigateToCanonical]);

  useEffect(() => {
    if (selected.kind === "article" && selected.id && toc.length > 0) {
      const foundChapter = toc.find((chapter) => (
        chapter.items.some((article) => article.article_number === selected.id) ||
        chapter.sections.some((section) => section.items.some((article) => article.article_number === selected.id))
      ));
      setOpenChapter(foundChapter?.label || null);
      return;
    }

    setOpenChapter(null);
  }, [selected, toc]);

  useEffect(() => {
    setIsAnnexesOpen(selected.kind === "annex" && !!selected.id);
  }, [selected]);

  const selectArticleIdx = useCallback((idx) => {
    const article = data.articles[idx];
    if (!article) return;
    setSelected({ kind: "article", id: article.article_number, html: article.article_html });
    navigateToCanonical("article", article.article_number);
  }, [data.articles, navigateToCanonical]);

  const selectRecitalIdx = useCallback((idx) => {
    const recital = data.recitals[idx];
    if (!recital) return;
    setSelected({ kind: "recital", id: recital.recital_number, html: recital.recital_html });
    navigateToCanonical("recital", recital.recital_number);
  }, [data.recitals, navigateToCanonical]);

  const selectAnnexIdx = useCallback((idx) => {
    const annex = data.annexes[idx];
    if (!annex) return;
    setSelected({ kind: "annex", id: annex.annex_id, html: annex.annex_html });
    navigateToCanonical("annex", annex.annex_id);
  }, [data.annexes, navigateToCanonical]);

  const onPrevNext = useCallback((entryKind, nextIndex) => {
    if (entryKind === "article") return selectArticleIdx(nextIndex);
    if (entryKind === "recital") return selectRecitalIdx(nextIndex);
    if (entryKind === "annex") return selectAnnexIdx(nextIndex);
  }, [selectAnnexIdx, selectArticleIdx, selectRecitalIdx]);

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  const onClickArticle = useCallback((article) => {
    const idx = data.articles.findIndex((entry) => entry.article_number === article.article_number);
    if (idx !== -1) selectArticleIdx(idx);
  }, [data.articles, selectArticleIdx]);

  const onClickRecital = useCallback((recital) => {
    const idx = data.recitals.findIndex((entry) => entry.recital_number === recital.recital_number);
    if (idx !== -1) selectRecitalIdx(idx);
  }, [data.recitals, selectRecitalIdx]);

  return {
    selected,
    toc,
    openChapter,
    setOpenChapter,
    isAnnexesOpen,
    setIsAnnexesOpen,
    mobileMenuOpen,
    setMobileMenuOpen,
    closeMobileMenu,
    selectArticleIdx,
    selectRecitalIdx,
    selectAnnexIdx,
    onPrevNext,
    onClickArticle,
    onClickRecital,
  };
}
