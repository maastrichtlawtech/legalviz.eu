const FULLTEXT_INDEX_UNAVAILABLE = 'fulltext_index_unavailable';
const FULLTEXT_INDEX_UNAVAILABLE_MESSAGE =
  'Full-text index is not available; metadata/title/excerpt search remains available but is not an equivalent fallback.';
const FULLTEXT_QUERY_ERROR_CODES = new Set([
  'fulltext_query_required',
  'fulltext_query_too_long',
  'fulltext_query_empty',
  'fulltext_query_too_short',
  'fulltext_query_too_many_terms',
]);

function isFulltextIndexUnavailable(error) {
  return error?.code === FULLTEXT_INDEX_UNAVAILABLE;
}

function isFulltextQueryError(error) {
  return FULLTEXT_QUERY_ERROR_CODES.has(error?.code);
}

module.exports = {
  FULLTEXT_INDEX_UNAVAILABLE,
  FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
  FULLTEXT_QUERY_ERROR_CODES,
  isFulltextIndexUnavailable,
  isFulltextQueryError,
};
