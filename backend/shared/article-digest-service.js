const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { chatComplete } = require('./openrouter-chat');

const CACHE_FILE = 'article-digest-cache-v1.json';
const CACHE_VERSION = 1;
const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 1;
const CASE_LAW_CACHE_VERSION = 'case-law-cache-v4';
const MAX_ARTICLE_TEXT_CHARS = 5500;
const MAX_DECLARATION_CHARS = 1800;

const inFlight = new Map();

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

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value, maxChars) {
  const text = stripTags(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function cacheKey(celex, articleNumber, lang) {
  return [
    String(celex || '').toUpperCase(),
    String(articleNumber || '').trim(),
    String(lang || 'ENG').toUpperCase(),
  ].join('_');
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function withSingleFlight(key, factory) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function loadCache(cacheDir) {
  try {
    const filePath = path.join(cacheDir, CACHE_FILE);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(cacheDir, cache) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, CACHE_FILE);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

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

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`Digest model did not return a JSON object; text=${snippet || '<empty>'}`);
  }
  return JSON.parse(match[0]);
}

function normalizeText(value, maxChars = 1200) {
  const text = stripTags(value);
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
}

function buildCitationIndex(input) {
  const byEcli = new Map();
  const byCelex = new Map();
  for (const c of input.cases || []) {
    const declarationNumbers = new Set((c.declarations || []).map((d) => String(d.number)));
    if (c.ecli) byEcli.set(c.ecli, { ...c, declarationNumbers });
    if (c.celex) byCelex.set(c.celex, { ...c, declarationNumbers });
  }
  return { byEcli, byCelex };
}

function normalizeCites(value, input) {
  const { byEcli, byCelex } = buildCitationIndex(input);
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((cite) => {
      if (!cite || typeof cite !== 'object') return null;
      const ecli = normalizeText(cite.ecli, 80);
      const celex = normalizeText(cite.celex, 40);
      const declarationNumber = normalizeText(cite.declarationNumber || cite.declaration || cite.paragraph, 20);
      const source = (ecli && byEcli.get(ecli)) || (celex && byCelex.get(celex));
      if (!source) return null;
      const normalizedDeclaration = source.declarationNumbers.has(String(declarationNumber))
        ? String(declarationNumber)
        : null;
      const key = `${source.ecli || source.celex}:${normalizedDeclaration || ''}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        ecli: source.ecli || null,
        celex: source.celex,
        declarationNumber: normalizedDeclaration,
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function parseArticleDigestJson(text, input) {
  const parsed = extractJsonObject(text);
  if (parsed.noCaseLaw === true || (input.cases || []).length === 0) {
    return { summary: '', themes: [], noCaseLaw: true };
  }

  const summary = normalizeText(parsed.summary, 1200);
  const themes = (Array.isArray(parsed.themes) ? parsed.themes : [])
    .map((theme) => {
      if (!theme || typeof theme !== 'object') return null;
      const name = normalizeText(theme.name, 120);
      const description = normalizeText(theme.description, 900);
      const cites = normalizeCites(theme.cites, input);
      if (!name || !description || cites.length === 0) return null;
      return { name, description, cites };
    })
    .filter(Boolean)
    .slice(0, 6);

  if (!summary) throw new Error('Digest is missing summary');
  if (themes.length === 0) throw new Error('Digest is missing cited themes');

  return { summary, themes, noCaseLaw: false };
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
  if ((input.cases || []).length === 0) {
    return {
      digest: { summary: '', themes: [], noCaseLaw: true },
      model,
      usage: null,
    };
  }

  const response = await chatCompleteImpl({
    model,
    apiKey,
    temperature: 0.1,
    maxTokens: 4000,
    responseFormat: 'json_object',
    reasoning: { max_tokens: 256, exclude: true },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });

  return {
    digest: parseArticleDigestJson(response.text, input),
    model: response.model || model,
    usage: response.usage || null,
  };
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
  const key = cacheKey(celex, articleNumber, lang || input.lang);

  return withSingleFlight(`article-digest:${key}:${sourceHash}:${model}`, async () => {
    const cache = cacheDir ? loadCache(cacheDir) : {};
    const cached = cache[key];
    if (
      cached?.version === CACHE_VERSION
      && cached?.schemaVersion === SCHEMA_VERSION
      && cached?.promptVersion === PROMPT_VERSION
      && cached?.caseLawCacheVersion === CASE_LAW_CACHE_VERSION
      && cached?.sourceHash === sourceHash
      && (cached?.model === model || cached?.digest?.noCaseLaw === true)
      && cached?.digest
    ) {
      return {
        digest: cached.digest,
        model: cached.model || model,
        generatedAt: cached.generatedAt || null,
        caseLawCacheVersion: cached.caseLawCacheVersion,
        cached: true,
      };
    }

    const generated = await generateArticleDigest(input, { apiKey, model, chatComplete: chatCompleteImpl });
    if (cacheDir) {
      cache[key] = {
        version: CACHE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        promptVersion: PROMPT_VERSION,
        caseLawCacheVersion: CASE_LAW_CACHE_VERSION,
        sourceHash,
        model: generated.digest.noCaseLaw ? null : (generated.model || model),
        generatedAt: new Date().toISOString(),
        digest: generated.digest,
      };
      saveCache(cacheDir, cache);
    }

    return {
      digest: generated.digest,
      model: generated.digest.noCaseLaw ? null : (generated.model || model),
      usage: generated.usage || null,
      generatedAt: cache[key]?.generatedAt || null,
      caseLawCacheVersion: CASE_LAW_CACHE_VERSION,
      cached: false,
    };
  });
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
