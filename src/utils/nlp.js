// NLP Algorithm Version - bump this when algorithm changes to invalidate cache
export const NLP_VERSION = 13;

const MONOTONICITY_BETA = 0.9;
const MONOTONICITY_GAMMA = 2;
const RAW_SIMILARITY_FLOOR = 0.15;
const SECONDARY_SCORE_RATIO = 0.75;
const MAX_ARTICLES_PER_RECITAL = 2;

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
 * Map recitals to articles based on TF-IDF Cosine Similarity with a positional prior.
 * 
 * @param {Array} recitals - Array of { recital_number, recital_text, ... }
 * @param {Array} articles - Array of { article_number, article_title, article_html, ... }
 * @returns {Map} - Map where key is article_number, value is array of matching recitals.
 *                  Unmapped recital numbers are exposed under the reserved null key.
 */
export function mapRecitalsToArticles(recitals, articles) {
  // Configuration
  const TITLE_WEIGHT = 3; // How many times to repeat title tokens for weighting

  // 1. Prepare Article Documents (Corpus)
  // Weight article titles more heavily by repeating their tokens
  const articleDocs = articles.map(a => {
    const titleTokens = tokenize(a.article_title || "");
    const bodyTokens = tokenize(stripTags(a.article_html));
    // Repeat title tokens for increased weight
    const weightedTitleTokens = [];
    for (let i = 0; i < TITLE_WEIGHT; i++) {
      weightedTitleTokens.push(...titleTokens);
    }
    return {
      id: a.article_number,
      tokens: [...weightedTitleTokens, ...bodyTokens],
      original: a
    };
  });

  // 2. Compute IDF on Articles
  const idf = computeIDF(articleDocs);

  // 3. Vectorize Articles
  const articleVectors = articleDocs.map(doc => ({
    id: doc.id,
    ...computeTFIDFVector(doc.tokens, idf)
  }));

  const articleToRecitals = new Map();
  articles.forEach(a => articleToRecitals.set(a.article_number, []));
  articleToRecitals.set(null, []);

  const recitalDenominator = Math.max(recitals.length - 1, 1);
  const articleDenominator = Math.max(articles.length - 1, 1);

  // 4. Process Recitals
  recitals.forEach((r, recitalIndex) => {
    const recitalText = r.recital_text || stripTags(r.recital_html) || "";
    const tokens = tokenize(recitalText);
    const recitalVec = computeTFIDFVector(tokens, idf);

    // Extract top keywords based on TF-IDF scores
    const keywordScores = new Map();
    for (const token of tokens) {
      if (idf.has(token)) {
        const score = idf.get(token);
        // Keep the highest score for each unique token
        if (!keywordScores.has(token) || keywordScores.get(token) < score) {
          keywordScores.set(token, score);
        }
      }
    }
    // Sort by IDF score (higher = more distinctive) and take top 3
    const keywords = Array.from(keywordScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([term]) => term);

    const scoredArticles = [];
    // Gate on raw evidence; choose the article with the monotonicity-weighted score.
    let strongestRawCos = 0;
    const rPos = recitalIndex / recitalDenominator;

    articleVectors.forEach((aVec, articleIndex) => {
      const rawCos = cosineSimilarity(recitalVec, aVec);
      strongestRawCos = Math.max(strongestRawCos, rawCos);
      const aPos = articleIndex / articleDenominator;
      const positionalPrior = (1 - MONOTONICITY_BETA * Math.abs(rPos - aPos)) ** MONOTONICITY_GAMMA;
      const score = rawCos * positionalPrior;

      scoredArticles.push({
        id: aVec.id,
        score,
      });
    });

    // Apply threshold and assign
    scoredArticles.sort((a, b) => b.score - a.score);
    const bestScore = scoredArticles[0]?.score || 0;

    if (strongestRawCos >= RAW_SIMILARITY_FLOOR && bestScore > 0) {
      const selectedArticles = scoredArticles
        .filter((candidate) => candidate.score >= bestScore * SECONDARY_SCORE_RATIO)
        .slice(0, MAX_ARTICLES_PER_RECITAL);

      for (const selectedArticle of selectedArticles) {
        const list = articleToRecitals.get(selectedArticle.id);
        if (list) {
          // Store with score and keywords for later processing
          list.push({ ...r, _score: selectedArticle.score, _keywords: keywords });
        }
      }
    } else {
      articleToRecitals.get(null).push(r.recital_number);
    }
  });

  // 5. Sort by score and expose relevance score + keywords
  for (const [articleId, recitalList] of articleToRecitals) {
    if (articleId === null) continue;
    if (recitalList.length > 0) {
      // Sort by score descending
      recitalList.sort((a, b) => (b._score || 0) - (a._score || 0));

      // Return only recital_number + computed fields (not full recital object)
      // This keeps cache small - HTML is looked up at render time from original data
      const sortedList = recitalList.map(r => ({
        recital_number: r.recital_number,
        relevanceScore: r._score,
        keywords: r._keywords
      }));

      articleToRecitals.set(articleId, sortedList);
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
