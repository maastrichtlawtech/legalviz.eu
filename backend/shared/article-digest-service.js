const { chatComplete } = require('./openrouter-chat');
const {
  clip,
  stableHash,
  makeSingleFlight,
  celexArticleLangKey,
} = require('./ai-digest-utils');
const {
  ensureThemedDigest,
  generateThemedDigest,
  parseThemedDigestJson,
} = require('./digest-service-core');

const {
  caseLawCacheVersion: CASE_LAW_CACHE_VERSION,
  articleDigest: {
    schemaVersion: SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
  },
} = require('./digest-cache-version.json');

const CACHE_FILE = 'article-digest-cache-v1.json';
const CACHE_VERSION = 1;
const MAX_ARTICLE_TEXT_CHARS = 5500;
const MAX_DECLARATION_CHARS = 1800;

const withSingleFlight = makeSingleFlight();

const SYSTEM_PROMPT = `You write concise digests of how CJEU case law interprets one article of an EU legal act.

Return ONLY a JSON object with this exact shape:
{
  "summary": "2-4 sentences narrating the doctrinal arc",
  "themes": [
    {
      "name": "short theme name",
      "description": "what the cited judgments establish",
      "cites": [{ "ecli": "ECLI from input", "declarationNumber": "declaration number from input" }]
    }
  ],
  "noCaseLaw": false
}

Rules:
- Use only the article and case-law input.
- Cite only ECLIs and declaration numbers present in the input.
- Do not cite judgment paragraph numbers; the input only contains operative declarations.
- Prefer 2-5 themes.
- If the input contains no matching cases, return {"summary":"","themes":[],"noCaseLaw":true}.`;

function matchesArticle(c, celex, articleNumber) {
  if (!c?.articleRefs || !articleNumber) return false;
  const target = String(articleNumber);
  return c.articleRefs.some(
    (ref) => ref && ref.actCelex === celex && String(ref.article) === target
  );
}

function normalizeCase(c, celex, articleNumber) {
  const matchingRefs = (c.articleRefs || [])
    .filter((ref) => ref && ref.actCelex === celex && String(ref.article) === String(articleNumber))
    .map((ref) => ({
      raw: ref.raw || null,
      article: ref.article || null,
      paragraph: ref.paragraph || null,
      point: ref.point || null,
    }));

  return {
    celex: c.celex,
    ecli: c.ecli || null,
    caseNumber: c.caseNumber || null,
    date: c.date || null,
    name: c.name || null,
    matchingRefs,
    declarations: (c.declarations || []).map((declaration) => ({
      number: String(declaration.number || '').trim(),
      text: clip(declaration.text || '', MAX_DECLARATION_CHARS),
    })).filter((declaration) => declaration.number && declaration.text),
  };
}

function buildArticleDigestInput(celex, articleNumber, parsedLaw, caseLawPayload) {
  const article = (parsedLaw.articles || []).find(
    (entry) => String(entry.article_number) === String(articleNumber)
  );
  const cases = Array.isArray(caseLawPayload)
    ? caseLawPayload
    : (caseLawPayload?.cases || []);
  const matchingCases = cases
    .filter((c) => matchesArticle(c, celex, articleNumber))
    .map((c) => normalizeCase(c, celex, articleNumber))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return {
    celex,
    lang: parsedLaw.lang || parsedLaw.langCode || null,
    title: parsedLaw.title || parsedLaw.doc_title || parsedLaw.name || null,
    article: article ? {
      number: String(article.article_number || '').trim(),
      title: article.article_title || null,
      chapter: article.division?.chapter?.title || null,
      section: article.division?.section?.title || null,
      text: clip(article.article_text || article.article_html || '', MAX_ARTICLE_TEXT_CHARS),
    } : null,
    cases: matchingCases,
  };
}

function parseArticleDigestJson(text, input) {
  return parseThemedDigestJson(text, input);
}

function buildUserPrompt(input) {
  return JSON.stringify({
    law: {
      celex: input.celex,
      lang: input.lang,
      title: input.title,
    },
    article: input.article,
    cases: input.cases,
  }, null, 2);
}

async function generateArticleDigest(input, {
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  return generateThemedDigest(input, {
    apiKey,
    model,
    chatComplete: chatCompleteImpl,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(input),
  });
}

async function ensureArticleDigest({
  celex,
  articleNumber,
  lang,
  parsedLaw,
  caseLawPayload,
  cacheDir,
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  const input = buildArticleDigestInput(celex, articleNumber, parsedLaw, caseLawPayload);
  if (!input.article) {
    throw new Error(`Article ${articleNumber} not found in ${celex}`);
  }
  const sourceHash = stableHash(input);
  const key = celexArticleLangKey(celex, articleNumber, lang || input.lang);

  return withSingleFlight(`article-digest:${key}:${sourceHash}:${model}`, () => ensureThemedDigest({
    input,
    key,
    sourceHash,
    cacheDir,
    cacheFile: CACHE_FILE,
    cacheVersion: CACHE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    caseLawCacheVersion: CASE_LAW_CACHE_VERSION,
    model,
    generate: (digestInput) => generateArticleDigest(digestInput, {
      apiKey,
      model,
      chatComplete: chatCompleteImpl,
    }),
  }));
}

module.exports = {
  CACHE_VERSION,
  CASE_LAW_CACHE_VERSION,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  buildArticleDigestInput,
  ensureArticleDigest,
  generateArticleDigest,
  matchesArticle,
  parseArticleDigestJson,
};
