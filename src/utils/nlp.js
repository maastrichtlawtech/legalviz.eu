// NLP Algorithm Version - bump this when algorithm changes to invalidate cache
export const NLP_VERSION = 15;

const MONOTONICITY_BETA = 0.9;
const MONOTONICITY_GAMMA = 2;
// How close a candidate recital's score must be to an article's own top score
// to also be considered relevant to that article (per-article secondary cutoff).
const SECONDARY_SCORE_RATIO = 0.75;
// An article only gets any recitals at all if its strongest candidate clears this
// fraction of *this law's own* typical "strong match" strength (see
// `computeRelevanceFloor`). This replaces a fixed absolute cosine floor — the
// right similarity magnitude varies by law length/language, so the floor is
// derived from the within-law distribution of scores instead of a hardcoded number.
const ARTICLE_RELEVANCE_FLOOR_RATIO = 0.25;
// Safety valve: caps how many recitals a single article can list even if many
// tie above the secondary-ratio cutoff, so a pathological tie doesn't flood the UI.
const MAX_RECITALS_PER_ARTICLE = 12;

import { getStopWords } from "./languages.js";

// Default (English) stop words — used when no language code is provided
const DEFAULT_STOP_WORDS = getStopWords("EN");

/**
 * Tokenize text into an array of words, removing punctuation and stop words.
 * @param {string} text
 * @param {string} [langCode] - Optional language code (e.g. "PL") for language-specific stop words
 * @returns {string[]}
 */
export function tokenize(text, langCode) {
  if (!text) return [];
  const stopWords = langCode ? getStopWords(langCode) : DEFAULT_STOP_WORDS;
  return text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F]/g, " ") // replace punctuation with space (keep accented/Polish chars)
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Compute Term Frequency (TF) for a document.
 * Returns a Map: term -> count
 */
function computeTF(tokens) {
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

/**
 * Compute Inverse Document Frequency (IDF) for a set of documents.
 * Returns a Map: term -> idf_score
 * idf(t) = log(N / df(t))
 */
function computeIDF(documents) {
  const N = documents.length;
  const df = new Map(); // term -> number of documents containing term

  for (const doc of documents) {
    const uniqueTokens = new Set(doc.tokens);
    for (const t of uniqueTokens) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [term, count] of df) {
    // Using log10. Adding 1 to denominator to be safe (though logic ensures count >= 1)
    idf.set(term, Math.log10(N / count));
  }
  return idf;
}

/**
 * Convert document tokens to a TF-IDF Vector (represented as a Map: term -> score).
 */
function computeTFIDFVector(tokens, idf) {
  const tf = computeTF(tokens);
  const vec = new Map();

  // Vector length (magnitude) for cosine normalization
  let magnitude = 0;

  for (const [term, count] of tf) {
    if (idf.has(term)) {
      const score = count * idf.get(term);
      vec.set(term, score);
      magnitude += score * score;
    }
  }

  return { vec, magnitude: Math.sqrt(magnitude) };
}

/**
 * Compute Cosine Similarity between two TF-IDF vectors.
 */
function cosineSimilarity(vec1Obj, vec2Obj) {
  if (vec1Obj.magnitude === 0 || vec2Obj.magnitude === 0) return 0;

  let dotProduct = 0;

  // Iterate over the smaller vector for efficiency
  const [smaller, larger] = vec1Obj.vec.size < vec2Obj.vec.size
    ? [vec1Obj.vec, vec2Obj.vec]
    : [vec2Obj.vec, vec1Obj.vec];

  for (const [term, score1] of smaller) {
    if (larger.has(term)) {
      dotProduct += score1 * larger.get(term);
    }
  }

  return dotProduct / (vec1Obj.magnitude * vec2Obj.magnitude);
}

/**
 * Helper to strip HTML tags and normalize whitespace
 */
const stripTags = (html) => {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Median of a numeric array (0 for an empty array).
 */
function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Build the corpus vectors + IDF shared by both the article and recital sides
 * of the retrieval (title-weighted article documents).
 */
function buildArticleCorpus(articles) {
  const TITLE_WEIGHT = 3; // How many times to repeat title tokens for weighting

  const articleDocs = articles.map(a => {
    const titleTokens = tokenize(a.article_title || "");
    const bodyTokens = tokenize(stripTags(a.article_html));
    const weightedTitleTokens = [];
    for (let i = 0; i < TITLE_WEIGHT; i++) {
      weightedTitleTokens.push(...titleTokens);
    }
    return {
      id: a.article_number,
      tokens: [...weightedTitleTokens, ...bodyTokens],
    };
  });

  const idf = computeIDF(articleDocs);
  const articleVectors = articleDocs.map(doc => ({
    id: doc.id,
    ...computeTFIDFVector(doc.tokens, idf)
  }));

  return { idf, articleVectors };
}

/**
 * Prepare each recital's TF-IDF vector and top keywords once, against a
 * given IDF (shared with the article corpus so scores are comparable).
 */
function prepareRecitalEntries(recitals, idf) {
  return recitals.map((r, recitalIndex) => {
    const recitalText = r.recital_text || stripTags(r.recital_html) || "";
    const tokens = tokenize(recitalText);
    const recitalVec = computeTFIDFVector(tokens, idf);

    const keywordScores = new Map();
    for (const token of tokens) {
      if (idf.has(token)) {
        const score = idf.get(token);
        if (!keywordScores.has(token) || keywordScores.get(token) < score) {
          keywordScores.set(token, score);
        }
      }
    }
    const keywords = Array.from(keywordScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([term]) => term);

    return { recital: r, recitalIndex, recitalVec, keywords, text: recitalText };
  });
}

/**
 * Score every recital against every "target" (article or article paragraph),
 * combining raw TF-IDF cosine similarity with a positional prior (targets/
 * recitals that sit at a similar relative position in the law are more
 * likely to be related — recitals are drafted roughly in article order).
 *
 * Returns a matrix: scoreMatrix[recitalIndex][targetIndex] = final score.
 */
function buildScoreMatrix(recitalEntries, targetVectors, recitalCount) {
  const recitalDenominator = Math.max(recitalCount - 1, 1);
  const targetDenominator = Math.max(targetVectors.length - 1, 1);

  return recitalEntries.map(({ recitalVec, recitalIndex }) => {
    const rPos = recitalIndex / recitalDenominator;
    return targetVectors.map((vec, targetIndex) => {
      const rawCos = cosineSimilarity(recitalVec, vec);
      const tPos = targetIndex / targetDenominator;
      const positionalPrior = (1 - MONOTONICITY_BETA * Math.abs(rPos - tPos)) ** MONOTONICITY_GAMMA;
      return rawCos * positionalPrior;
    });
  });
}

/**
 * For each target (article or paragraph), retrieve its own ranked list of
 * relevant recitals independently — a recital may end up under several
 * targets (many-to-many), unlike an exclusive-assignment/partition model.
 *
 * Gating is two-layered and entirely relative to *this law's* own score
 * distribution (no hardcoded absolute cosine floor):
 *  1. A target-level relevance floor: a target only gets any recitals if its
 *     own strongest candidate clears a fraction (ARTICLE_RELEVANCE_FLOOR_RATIO)
 *     of the median "best match" strength across all targets in this law.
 *     This is what lets an irrelevant target abstain (a common, valid outcome).
 *  2. A secondary-cutoff: among a target's candidates, keep those within
 *     SECONDARY_SCORE_RATIO of that target's own top score (plus a sane cap),
 *     so a target isn't flooded with weakly-related recitals.
 *
 * @returns {Array<Array<{recitalIndex:number, score:number}>>} selected candidates per target index
 */
function retrieveRecitalsPerTarget(scoreMatrix, targetCount) {
  const targetBestScores = [];
  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    let best = 0;
    for (const row of scoreMatrix) {
      if (row[targetIndex] > best) best = row[targetIndex];
    }
    targetBestScores.push(best);
  }

  const referenceStrength = median(targetBestScores.filter((s) => s > 0));
  const relevanceFloor = referenceStrength * ARTICLE_RELEVANCE_FLOOR_RATIO;

  const selectedPerTarget = [];
  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    const candidates = [];
    scoreMatrix.forEach((row, recitalIndex) => {
      const score = row[targetIndex];
      if (score > 0) candidates.push({ recitalIndex, score });
    });

    if (candidates.length === 0) {
      selectedPerTarget.push([]);
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const bestScore = candidates[0].score;

    if (bestScore < relevanceFloor) {
      selectedPerTarget.push([]); // abstain — nothing clears this law's relevance bar
      continue;
    }

    const selected = candidates
      .filter((c) => c.score >= bestScore * SECONDARY_SCORE_RATIO)
      .slice(0, MAX_RECITALS_PER_ARTICLE);

    selectedPerTarget.push(selected);
  }

  return selectedPerTarget;
}

/**
 * STEP 6 MVP — paragraph-level linking.
 *
 * Given a recital already established as relevant to an article (step 4),
 * find which of that article's structured `paragraphs` it most likely
 * clarifies. Kept deliberately simple for the MVP: a small TF-IDF corpus
 * scoped to *just this article's own paragraphs* (typically 2-10 documents),
 * rather than a single law-wide paragraph index — cheap, and the article-level
 * match has already narrowed the search space to one article.
 *
 * TODO (full UX, not in MVP scope): surface this per-paragraph link with real
 * UI (e.g. jump-to-paragraph, highlight-in-place) instead of a numeric badge;
 * consider a law-wide paragraph corpus if per-article scoping proves too
 * narrow (e.g. a recital whose clearest match is a near-duplicate paragraph
 * in a neighbouring article); reuse buildScoreMatrix/retrieveRecitalsPerTarget
 * here too if/when multiple recitals need ranking against the same paragraph.
 *
 * @param {Array} paragraphs - article.paragraphs, i.e. [{ number, html }]
 * @returns {{idf: Map, paragraphVectors: Array}|null} the scoped corpus, or
 *   null when there's nothing to disambiguate (0-1 paragraphs).
 */
function buildParagraphCorpus(paragraphs) {
  if (!paragraphs || paragraphs.length <= 1) return null;

  const paragraphDocs = paragraphs.map((p, idx) => ({
    id: p.number ?? String(idx),
    tokens: tokenize(stripTags(p.html)),
  }));
  const idf = computeIDF(paragraphDocs);
  const paragraphVectors = paragraphDocs.map((doc) => ({
    id: doc.id,
    ...computeTFIDFVector(doc.tokens, idf),
  }));
  return { idf, paragraphVectors };
}

/**
 * Match a single recital against a pre-built paragraph corpus (see
 * `buildParagraphCorpus`). The corpus depends only on the article, so it is
 * built once per article and reused across that article's matched recitals.
 *
 * @param {string} recitalText - plain-text (HTML-stripped) recital content
 * @param {{idf: Map, paragraphVectors: Array}|null} corpus
 * @returns {string|null} best-matching paragraph number, or null when there's
 *   no corpus or no real term overlap.
 */
function matchParagraph(recitalText, corpus) {
  if (!corpus) return null;

  const recitalVec = computeTFIDFVector(tokenize(recitalText), corpus.idf);
  if (recitalVec.magnitude === 0) return null;

  let bestId = null;
  let bestScore = 0;
  for (const pVec of corpus.paragraphVectors) {
    const score = cosineSimilarity(recitalVec, pVec);
    if (score > bestScore) {
      bestScore = score;
      bestId = pVec.id;
    }
  }
  // Only report a paragraph when there's genuine term overlap — otherwise
  // this would just be reporting an arbitrary tie-break default.
  return bestScore > 0 ? bestId : null;
}

/**
 * Map recitals to articles based on TF-IDF Cosine Similarity with a positional prior.
 *
 * Retrieval runs *per article* (many-to-many): a recital that clarifies several
 * articles will appear under all of them, rather than being exclusively assigned
 * to at most a couple of "winning" articles.
 *
 * Also attaches a best-effort `paragraph_number` (step 6 MVP) to each matched
 * recital when the article has structured paragraphs — see `matchParagraph`.
 *
 * @param {Array} recitals - Array of { recital_number, recital_text, ... }
 * @param {Array} articles - Array of { article_number, article_title, article_html, paragraphs?, ... }
 * @returns {Map} - Map where key is article_number, value is array of
 *                  { recital_number, relevanceScore, keywords, paragraph_number },
 *                  ranked by relevance. `paragraph_number` is null when the
 *                  article has no structured paragraphs to disambiguate, or no
 *                  single paragraph stands out.
 *                  Recitals that don't clear the bar for any article are exposed
 *                  under the reserved null key (array of recital_number).
 */
export function mapRecitalsToArticles(recitals, articles) {
  const { idf, articleVectors } = buildArticleCorpus(articles);

  const articleToRecitals = new Map();
  articles.forEach(a => articleToRecitals.set(a.article_number, []));
  articleToRecitals.set(null, []);

  const recitalEntries = prepareRecitalEntries(recitals, idf);
  const scoreMatrix = buildScoreMatrix(recitalEntries, articleVectors, recitals.length);
  const selectedPerArticle = retrieveRecitalsPerTarget(scoreMatrix, articleVectors.length);

  const paragraphsByArticle = new Map(articles.map((a) => [a.article_number, a.paragraphs]));
  const assignedRecitalNumbers = new Set();

  articleVectors.forEach((aVec, articleIndex) => {
    const list = articleToRecitals.get(aVec.id);
    if (!list) return;

    const paragraphs = paragraphsByArticle.get(aVec.id);
    // Build the article's paragraph corpus once and reuse it for every recital
    // matched to this article (the corpus depends only on the article).
    const paragraphCorpus = buildParagraphCorpus(paragraphs);

    for (const { recitalIndex, score } of selectedPerArticle[articleIndex]) {
      const { recital, keywords, text } = recitalEntries[recitalIndex];
      const paragraph_number = matchParagraph(text, paragraphCorpus);
      list.push({ recital_number: recital.recital_number, relevanceScore: score, keywords, paragraph_number });
      assignedRecitalNumbers.add(recital.recital_number);
    }

    list.sort((a, b) => b.relevanceScore - a.relevanceScore);
  });

  for (const { recital } of recitalEntries) {
    if (!assignedRecitalNumbers.has(recital.recital_number)) {
      articleToRecitals.get(null).push(recital.recital_number);
    }
  }

  return articleToRecitals;
}


/**
 * Pre-compute search index for a given law data.
 * @param {Object} data - { articles, recitals, annexes }
 * @returns {Object} - Index object containing docs with vectors and IDF
 */
export function buildSearchIndex(data) {
  const docs = [];

  if (data.articles) {
    data.articles.forEach(a => {
      const text = stripTags(a.article_html);
      const langCode = a.langCode;
      docs.push({
        type: 'article',
        id: a.article_number,
        title: a.article_title ? `Art. ${a.article_number} - ${a.article_title}` : `Article ${a.article_number}`,
        text: text,
        tokens: tokenize(text + " " + (a.article_title || "") + " Article " + a.article_number, langCode),
        preview: text.substring(0, 150) + "...",
        law_label: a.law_label, // Add law context
        law_key: a.law_key,
        law_slug: a.law_slug,
        routeKind: a.routeKind,
        celex: a.celex,
        raw: a.raw,
        langCode,
      });
    });
  }

  if (data.recitals) {
    data.recitals.forEach(r => {
      const text = stripTags(r.recital_html);
      const langCode = r.langCode;
      docs.push({
        type: 'recital',
        id: r.recital_number,
        title: r.recital_title ? `Recital ${r.recital_number} - ${r.recital_title}` : `Recital ${r.recital_number}`,
        text: text,
        tokens: tokenize(text + " " + (r.recital_title || "") + " Recital " + r.recital_number, langCode),
        preview: text.substring(0, 150) + "...",
        law_label: r.law_label,
        law_key: r.law_key,
        law_slug: r.law_slug,
        routeKind: r.routeKind,
        celex: r.celex,
        raw: r.raw,
        langCode,
      });
    });
  }

  if (data.annexes) {
    data.annexes.forEach(a => {
      const text = stripTags(a.annex_html);
      const langCode = a.langCode;
      docs.push({
        type: 'annex',
        id: a.annex_id,
        title: `Annex ${a.annex_id} - ${a.annex_title}`,
        text: text,
        tokens: tokenize(text + " " + (a.annex_title || "") + " Annex " + a.annex_id, langCode),
        preview: text.substring(0, 150) + "...",
        law_label: a.law_label,
        law_key: a.law_key,
        law_slug: a.law_slug,
        routeKind: a.routeKind,
        celex: a.celex,
        raw: a.raw,
        langCode,
      });
    });
  }

  const idf = computeIDF(docs);

  // Pre-compute vectors for all docs
  const docVectors = docs.map(doc => ({
    ...doc,
    vec: computeTFIDFVector(doc.tokens, idf)
  }));

  return { docs: docVectors, idf };
}

/**
 * Search using a pre-computed index.
 * @param {string} query 
 * @param {Object} index 
 */
export function searchIndex(query, index) {
  if (!query || query.length < 2) return [];
  if (!index || !index.docs) return [];

  const q = query.toLowerCase();
  const qTokens = tokenize(q);

  if (qTokens.length === 0) {
    // Fallback to simple substring match on pre-processed docs
    return simpleSearchDocs(query, index.docs);
  }

  const queryVec = computeTFIDFVector(qTokens, index.idf);

  const results = index.docs.map(doc => {
    let score = cosineSimilarity(queryVec, doc.vec) * 100;

    const titleLower = doc.title.toLowerCase();
    const idStr = String(doc.id).toLowerCase();

    // Exact ID match
    if (q === idStr) score += 200;

    // "Article X" type match
    if (doc.type === 'article' && q.replace(/\s/g, '') === `article${idStr}`) score += 200;
    if (doc.type === 'recital' && q.replace(/\s/g, '') === `recital${idStr}`) score += 200;

    // Title substring match
    if (titleLower.includes(q)) score += 50;

    return {
      ...doc,
      score
    };
  });

  return results
    .filter(r => r.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .map(r => ({ ...r, vec: undefined })); // Clean up output
}

function simpleSearchDocs(query, docs) {
  const q = query.toLowerCase();
  return docs
    .filter(doc => doc.text.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q))
    .map(doc => ({
      ...doc,
      score: 1,
      vec: undefined
    }));
}

/**
 * Simple search function using TF-IDF and cosine similarity.
 * Now a wrapper around buildSearchIndex and searchIndex.
 */
export function searchContent(query, data) {
  const index = buildSearchIndex(data);
  return searchIndex(query, index);
}
