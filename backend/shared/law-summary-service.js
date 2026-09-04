const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chatComplete } = require('./openrouter-chat');
const { inferTypeFromCelex } = require('../search/search-ranking');
const {
  cacheVersion: CACHE_VERSION,
  schemaVersion: SCHEMA_VERSION,
  promptVersion: PROMPT_VERSION,
} = require('./law-summary-cache-version.json');
const {
  stripTags,
  normalizeText,
  stableHash,
  makeSingleFlight,
  loadCache,
  saveCacheEntry,
  extractJsonObject,
  celexLangKey,
} = require('./ai-digest-utils');

const CACHE_FILE = 'law-summary-cache-v1.json';
const MAX_ARTICLE_TEXT_CHARS = 6000;
const MAX_RECITAL_COUNT = 60;
const MAX_RECITAL_TEXT_CHARS = 700;
const MAX_ARTICLE_TEXT_BUDGET_CHARS = 500000;

const ACT_TYPE_GUIDANCE = {
  regulation: 'This is a regulation: frame key points as directly-applicable obligations, rights, and prohibitions binding on the addressees themselves.',
  directive: 'This is a directive: frame key points as duties on Member States, i.e. what must be transposed into national law and by when if a deadline is stated, not direct obligations on private parties.',
  decision: 'This is a decision or establishing act: frame key points around the addressees, the body or authority it creates, and that body\'s powers and mandate.',
  unknown: 'The act type could not be determined: frame key points generically as obligations, rights, powers, or prohibitions as best supported by the text.',
};

const withSingleFlight = makeSingleFlight();

function buildSystemPrompt(actType) {
  const guidance = ACT_TYPE_GUIDANCE[actType] || ACT_TYPE_GUIDANCE.unknown;
  return `You write concise, grounded summaries of EU legal acts for a legal research reader.

${guidance}

Return ONLY a JSON object with this exact shape:
{
  "purpose": { "text": "1-2 sentences", "citations": ["1", "2"] },
  "scope": { "text": "who or what the law applies to", "citations": ["2", "3"] },
  "keyPoints": [
    { "text": "one concrete obligation, right, power, or prohibition", "citations": ["5"] }
  ],
  "structure": "short narrative of how the chapters/sections are organised"
}

Rules:
- Use only the provided law input.
- Every scope and key-point item must cite existing article numbers from the provided article list.
- Prefer 3-6 key points.
- Keep the whole output under about 400 words.
- Do not invent article numbers, obligations, or legal effects.`;
}

// Sentence-boundary-aware truncation, specific to the summary feature (the
// digest features use the plain clip in ai-digest-utils).
function clip(value, maxChars) {
  const text = stripTags(value);
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  // stripTags collapses all whitespace (incl. newlines) to single spaces, so
  // sentence boundaries here are a period/semicolon followed by a space.
  const boundaryPattern = /[.;]\s/g;
  let lastBoundaryEnd = -1;
  let match;
  while ((match = boundaryPattern.exec(window))) {
    lastBoundaryEnd = match.index + match[0].length;
  }
  if (lastBoundaryEnd > 0) {
    return `${window.slice(0, lastBoundaryEnd).trim()}…`;
  }
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return `${cut.trim()}…`;
}

function rawSourceHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Resolve a cache-entry sourceFile back to an absolute path, rejecting
 * anything that would escape the cache directory (entries come from our own
 * cache file, but it lives on disk and could be edited).
 */
function resolveSourceFilePath(cacheDir, sourceFile) {
  if (!cacheDir || !sourceFile) return null;
  const resolved = path.resolve(cacheDir, sourceFile);
  if (!resolved.startsWith(path.resolve(cacheDir) + path.sep)) return null;
  return resolved;
}

function isServableEntry(entry, model) {
  return entry?.version === CACHE_VERSION
    && entry?.schemaVersion === SCHEMA_VERSION
    && entry?.promptVersion === PROMPT_VERSION
    && entry?.model === model
    && Boolean(entry?.summary);
}

function cachedResult(entry) {
  return {
    summary: entry.summary,
    model: entry.model,
    generatedAt: entry.generatedAt || null,
    cached: true,
  };
}

/**
 * Return a current cached summary without resolving or parsing the law.
 *
 * This read-only path intentionally validates only the versioned cache entry
 * and requested model: it must never migrate or otherwise write cache state.
 * Static summaries are currently English-only, so use the existing CELEX+ENG
 * cache key regardless of any caller language state.
 */
function getCachedLawSummary({ celex, cacheDir, model } = {}) {
  if (!cacheDir) return null;

  const key = celexLangKey(celex, 'ENG');
  const cache = loadCache(cacheDir, CACHE_FILE);
  const entry = cache[key];
  return isServableEntry(entry, model) ? cachedResult(entry) : null;
}

function buildSkeleton(articles) {
  return (articles || []).map((article) => ({
    number: String(article.article_number || '').trim(),
    title: article.article_title || null,
    chapter: article.division?.chapter?.title || null,
    section: article.division?.section?.title || null,
  })).filter((article) => article.number);
}

function buildLawSummaryInput(parsedLaw) {
  let articleTextBudgetUsed = 0;
  const articles = (parsedLaw.articles || [])
    .map((article) => {
      let text = '';
      if (articleTextBudgetUsed < MAX_ARTICLE_TEXT_BUDGET_CHARS) {
        text = clip(article.article_text || article.article_html || '', MAX_ARTICLE_TEXT_CHARS);
        articleTextBudgetUsed += text.length;
      }
      return {
        number: String(article.article_number || '').trim(),
        title: article.article_title || null,
        chapter: article.division?.chapter?.title || null,
        section: article.division?.section?.title || null,
        text,
      };
    })
    .filter((article) => article.number && article.text);

  return {
    celex: parsedLaw.celex || null,
    lang: parsedLaw.lang || parsedLaw.langCode || null,
    title: parsedLaw.title || parsedLaw.doc_title || parsedLaw.name || null,
    eli: parsedLaw.eli || null,
    source: parsedLaw.source || null,
    actType: inferTypeFromCelex(parsedLaw.celex),
    skeleton: buildSkeleton(parsedLaw.articles || []),
    definitions: (parsedLaw.definitions || [])
      .map((definition) => ({
        term: definition.term,
        sourceArticle: definition.sourceArticle || definition.source_article || null,
      }))
      .filter((definition) => definition.term),
    recitals: (parsedLaw.recitals || []).slice(0, MAX_RECITAL_COUNT).map((recital) => ({
      number: String(recital.recital_number || '').trim(),
      text: clip(recital.recital_text || recital.recital_html || '', MAX_RECITAL_TEXT_CHARS),
    })).filter((recital) => recital.number && recital.text),
    articles,
  };
}

function normalizeCitations(value, validArticles) {
  const values = Array.isArray(value) ? value : [];
  return Array.from(new Set(values
    .map((citation) => String(citation || '').replace(/^Art\.?\s*/i, '').trim())
    .filter((citation) => validArticles.has(citation))));
}

function normalizeCitedBlock(value, validArticles, { requireCitation = false } = {}) {
  const block = value && typeof value === 'object'
    ? value
    : { text: value, citations: [] };
  const text = normalizeText(block.text, 900);
  const citations = normalizeCitations(block.citations, validArticles);
  if (!text) return null;
  if (requireCitation && citations.length === 0) return null;
  return { text, citations };
}

function parseLawSummaryJson(text, input) {
  const parsed = extractJsonObject(text, { label: 'Summary model' });
  const validArticles = new Set([
    ...(input.articles || []).map((article) => String(article.number)),
    ...(input.skeleton || []).map((article) => String(article.number)),
  ]);
  const purpose = normalizeCitedBlock(parsed.purpose, validArticles);
  const scope = normalizeCitedBlock(parsed.scope, validArticles, { requireCitation: true });
  const keyPoints = (Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [])
    .map((item) => normalizeCitedBlock(item, validArticles, { requireCitation: true }))
    .filter(Boolean)
    .slice(0, 8);
  const structure = normalizeText(parsed.structure, 1000);

  if (!purpose?.text) throw new Error('Summary is missing purpose');
  if (!scope?.text) throw new Error('Summary is missing cited scope');
  if (keyPoints.length === 0) throw new Error('Summary is missing cited key points');
  if (!structure) throw new Error('Summary is missing structure');

  return {
    purpose,
    scope,
    keyPoints,
    structure,
  };
}

function buildUserPrompt(input) {
  return JSON.stringify({
    law: {
      celex: input.celex,
      lang: input.lang,
      title: input.title,
      eli: input.eli,
      source: input.source,
      actType: input.actType,
    },
    articleIndex: input.skeleton,
    definitions: input.definitions,
    openingRecitals: input.recitals,
    articles: input.articles,
  }, null, 2);
}

async function generateLawSummary(input, {
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  const response = await chatCompleteImpl({
    model,
    apiKey,
    temperature: 0.1,
    maxTokens: 3000,
    responseFormat: 'json_object',
    reasoning: { max_tokens: 256, exclude: true },
    messages: [
      { role: 'system', content: buildSystemPrompt(input.actType) },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });

  return {
    summary: parseLawSummaryJson(response.text, input),
    model: response.model || model,
    usage: response.usage || null,
  };
}

/**
 * Return a validated summary for a law, generating (and caching) it only when
 * needed. Callers can pass either an already-parsed law (`parsedLaw`) or lazy
 * providers so that a cache hit never pays for source resolution or parsing:
 *
 * - `getSource()` resolves the raw law source and returns
 *   `{ rawText, sourceFile }` (or null to defer entirely to `getParsedLaw`).
 *   `sourceFile` is a cacheDir-relative path remembered in the cache entry.
 * - `getParsedLaw(rawText)` parses the law; `rawText` is the source text from
 *   `getSource()` when available, otherwise null.
 *
 * Cache validation is layered from cheapest to most expensive: a stored
 * rawHash matching the bytes of the remembered source file (no parse), then a
 * rawHash match against freshly resolved source text (no parse), then the
 * sourceHash of the parsed summary input (parse, but no model call).
 */
async function ensureLawSummary({
  celex,
  lang,
  parsedLaw,
  getSource,
  getParsedLaw,
  cacheDir,
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  const key = celexLangKey(celex || parsedLaw?.celex, lang || parsedLaw?.lang);

  return withSingleFlight(`law-summary:${key}:${model}`, async () => {
    const cache = cacheDir ? loadCache(cacheDir, CACHE_FILE) : {};
    const cached = cache[key];
    const servable = isServableEntry(cached, model);

    // Fast path: the cache entry remembers which source file it was built
    // from; if those bytes are unchanged the summary is current, with no
    // upstream lookup and no Formex parse.
    if (servable && cached.rawHash) {
      const sourceFilePath = resolveSourceFilePath(cacheDir, cached.sourceFile);
      if (sourceFilePath) {
        try {
          if (rawSourceHash(await fs.promises.readFile(sourceFilePath, 'utf8')) === cached.rawHash) {
            return cachedResult(cached);
          }
        } catch {
          // Unreadable file: fall through to the slower paths.
        }
      }
    }

    const source = !parsedLaw && typeof getSource === 'function' ? await getSource() : null;
    const rawHash = source?.rawText != null ? rawSourceHash(source.rawText) : null;

    // The source was re-resolved but its bytes are unchanged: still no parse
    // needed. Refresh the remembered file name if it moved.
    if (servable && rawHash && cached.rawHash === rawHash) {
      if (cacheDir && cached.sourceFile !== (source.sourceFile || null)) {
        saveCacheEntry(cacheDir, CACHE_FILE, key, { ...cached, sourceFile: source.sourceFile || null });
      }
      return cachedResult(cached);
    }

    const parsed = parsedLaw || await getParsedLaw(source ? source.rawText : null);
    const input = buildLawSummaryInput(parsed);
    const sourceHash = stableHash(input);

    if (servable && cached.sourceHash === sourceHash) {
      // Same parsed input: adopt the raw-source fingerprint so the next
      // request can take the fast path without re-parsing. This also
      // migrates entries written before rawHash/sourceFile existed.
      let entry = cached;
      if (cacheDir && rawHash && (cached.rawHash !== rawHash || cached.sourceFile !== (source.sourceFile || null))) {
        entry = { ...cached, rawHash, sourceFile: source.sourceFile || null };
        saveCacheEntry(cacheDir, CACHE_FILE, key, entry);
      }
      return cachedResult(entry);
    }

    const generated = await generateLawSummary(input, { apiKey, model, chatComplete: chatCompleteImpl });
    let entry = null;
    if (cacheDir) {
      entry = {
        version: CACHE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        promptVersion: PROMPT_VERSION,
        sourceHash,
        rawHash,
        sourceFile: source?.sourceFile || null,
        model: generated.model || model,
        generatedAt: new Date().toISOString(),
        summary: generated.summary,
      };
      saveCacheEntry(cacheDir, CACHE_FILE, key, entry);
    }

    return {
      summary: generated.summary,
      model: generated.model || model,
      usage: generated.usage || null,
      generatedAt: entry?.generatedAt || null,
      cached: false,
    };
  });
}

module.exports = {
  CACHE_VERSION,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  buildLawSummaryInput,
  ensureLawSummary,
  getCachedLawSummary,
  generateLawSummary,
  parseLawSummaryJson,
  rawSourceHash,
};
