const { chatComplete } = require('./openrouter-chat');
const { inferTypeFromCelex } = require('../search/search-ranking');
const {
  clip,
  normalizeText,
  stableHash,
  makeSingleFlight,
  loadCache,
  saveCache,
  extractJsonObject,
  normalizeCites,
} = require('./ai-digest-utils');

const CACHE_FILE = 'case-law-digest-cache-v1.json';
const CACHE_VERSION = 1;
const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 1;
// Kept in lock-step with law-queries' CASE_LAW_CACHE_FILE so the digest is
// regenerated whenever the underlying enrichment (declarations, article refs)
// changes shape.
const CASE_LAW_CACHE_VERSION = 'case-law-cache-v5';

const MAX_CASES = 60;
const MAX_DECLARATION_CHARS = 1200;
const MAX_DECLARATIONS_PER_CASE = 6;
const MAX_ARTICLES_CITED_PER_CASE = 12;
const MAX_DECLARATION_BUDGET_CHARS = 120000;
const MAX_CITES_PER_THEME = 8;

const withSingleFlight = makeSingleFlight();

const ACT_TYPE_NOUN = {
  regulation: 'regulation',
  directive: 'directive',
  decision: 'act',
  unknown: 'act',
};

const SYSTEM_PROMPT = `You write concise digests of how CJEU case law interprets a whole EU legal act.

You are given the act's identity plus a list of judgments that interpret it, each with its operative-part declarations and the articles it cites. Group the case law into a few doctrinal themes across the whole act.

Return ONLY a JSON object with this exact shape:
{
  "summary": "2-4 sentences narrating the overall doctrinal arc of the case law on this act",
  "themes": [
    {
      "name": "short theme name",
      "description": "what the cited judgments establish, mentioning the relevant articles where useful",
      "cites": [{ "ecli": "ECLI from input", "declarationNumber": "declaration number from input, or omit" }]
    }
  ],
  "noCaseLaw": false
}

Rules:
- Use only the provided case-law input.
- Cite only ECLIs present in the input; only use a declarationNumber that appears for that judgment in the input.
- Do not cite judgment paragraph numbers; the input only contains operative declarations.
- Prefer 3-6 themes, each grounded in one or more judgments.
- Keep the whole output under about 400 words.
- If the input contains no usable case law, return {"summary":"","themes":[],"noCaseLaw":true}.`;

function cacheKey(celex, lang) {
  return `${String(celex || '').toUpperCase()}_${String(lang || 'ENG').toUpperCase()}`;
}

function normalizeCase(c, { includeDeclarations }) {
  const declarations = includeDeclarations
    ? (c.declarations || [])
      .slice(0, MAX_DECLARATIONS_PER_CASE)
      .map((declaration) => ({
        number: String(declaration.number || '').trim(),
        text: clip(declaration.text || '', MAX_DECLARATION_CHARS),
      }))
      .filter((declaration) => declaration.number && declaration.text)
    : [];

  return {
    celex: c.celex,
    ecli: c.ecli || null,
    caseNumber: c.caseNumber || null,
    date: c.date || null,
    name: c.name || null,
    articlesCited: (c.articlesCited || []).slice(0, MAX_ARTICLES_CITED_PER_CASE),
    declarations,
  };
}

function buildCaseLawDigestInput(celex, parsedLaw, caseLawPayload) {
  const cases = Array.isArray(caseLawPayload)
    ? caseLawPayload
    : (caseLawPayload?.cases || []);

  const sorted = cases
    .filter((c) => c && c.celex)
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const totalCases = sorted.length;
  const selected = sorted.slice(0, MAX_CASES);

  // Spend the declaration-text budget on the most recent judgments first; once
  // exhausted, later judgments are still listed (so they can be cited) but
  // without operative text.
  let declarationBudgetUsed = 0;
  const normalizedCases = selected.map((c) => {
    const caseCharCost = (c.declarations || [])
      .slice(0, MAX_DECLARATIONS_PER_CASE)
      .reduce((sum, d) => sum + clip(d.text || '', MAX_DECLARATION_CHARS).length, 0);
    const includeDeclarations = declarationBudgetUsed < MAX_DECLARATION_BUDGET_CHARS;
    if (includeDeclarations) declarationBudgetUsed += caseCharCost;
    return normalizeCase(c, { includeDeclarations });
  });

  return {
    celex,
    lang: parsedLaw?.lang || parsedLaw?.langCode || null,
    title: parsedLaw?.title || parsedLaw?.doc_title || parsedLaw?.name || null,
    actType: inferTypeFromCelex(celex),
    totalCases,
    includedCases: normalizedCases.length,
    cases: normalizedCases,
  };
}

function parseCaseLawDigestJson(text, input) {
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
      const cites = normalizeCites(theme.cites, input, { limit: MAX_CITES_PER_THEME });
      if (!name || !description || cites.length === 0) return null;
      return { name, description, cites };
    })
    .filter(Boolean)
    .slice(0, 6);

  // A well-formed response can still fail to ground anything (e.g. when the
  // judgments have no parsed operative-part declarations to cite). Treat that
  // as "no case law" rather than throwing, so the outcome gets cached instead
  // of re-invoking the model on every request.
  if (!summary || themes.length === 0) {
    return { summary: '', themes: [], noCaseLaw: true };
  }

  return { summary, themes, noCaseLaw: false };
}

function buildUserPrompt(input) {
  return JSON.stringify({
    law: {
      celex: input.celex,
      lang: input.lang,
      title: input.title,
      actType: input.actType,
      actNoun: ACT_TYPE_NOUN[input.actType] || ACT_TYPE_NOUN.unknown,
    },
    caseCount: input.totalCases,
    casesShown: input.includedCases,
    cases: input.cases,
  }, null, 2);
}

async function generateCaseLawDigest(input, {
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
    digest: parseCaseLawDigestJson(response.text, input),
    model: response.model || model,
    usage: response.usage || null,
  };
}

async function ensureCaseLawDigest({
  celex,
  lang,
  parsedLaw,
  caseLawPayload,
  cacheDir,
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  const input = buildCaseLawDigestInput(celex, parsedLaw, caseLawPayload);
  const sourceHash = stableHash(input);
  const key = cacheKey(celex, lang || input.lang);

  return withSingleFlight(`case-law-digest:${key}:${sourceHash}:${model}`, async () => {
    const cache = cacheDir ? loadCache(cacheDir, CACHE_FILE) : {};
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

    const generated = await generateCaseLawDigest(input, { apiKey, model, chatComplete: chatCompleteImpl });
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
      saveCache(cacheDir, CACHE_FILE, cache);
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
  buildCaseLawDigestInput,
  ensureCaseLawDigest,
  generateCaseLawDigest,
  parseCaseLawDigestJson,
};
