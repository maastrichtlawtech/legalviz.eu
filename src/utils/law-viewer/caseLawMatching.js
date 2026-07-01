export function matchesArticle(c, celex, articleNumber) {
  if (!c?.articleRefs || !articleNumber) return false;
  const target = String(articleNumber);
  return c.articleRefs.some(
    (ref) => ref && ref.actCelex === celex && String(ref.article) === target
  );
}
