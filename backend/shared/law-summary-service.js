const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { chatComplete } = require('./openrouter-chat');
const { ACT_CELEX_MAP } = require('./law-queries');

const CACHE_FILE = 'law-summary-cache-v1.json';
const CACHE_VERSION = 1;
const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 1;
const MAX_ARTICLE_TEXT_CHARS = 1200;
const MAX_RECITAL_TEXT_CHARS = 700;
const MAX_RELATED_CANDIDATES = 12;

const inFlight = new Map();

const SYSTEM_PROMPT = `You write concise, grounded summaries of EU legal acts for a legal research reader.

Return ONLY a JSON object with this exact shape:
{
  "purpose": { "text": "1-2 sentences", "citations": ["1", "2"] },
  "scope": { "text": "who or what the law applies to", "citations": ["2", "3"] },
  "keyObligations": [
    { "text": "one concrete obligation, right, power, or prohibition", "citations": ["5"] }
  ],
  "structure": "short narrative of how the chapters/sections are organised",
  "relatedInstruments": [
    { "label": "instrument name or reference from the candidates", "celex": "optional CELEX from candidates", "relationship": "why it is related" }
  ]
}

Rules:
- Use only the provided law input and related-instrument candidates.
- Every scope and key-obligation item must cite existing article numbers from the provided article list.
- Prefer 3-6 key obligations.
- Keep the whole output under about 400 words.
- Do not invent article numbers, CELEX identifiers, instruments, obligations, or legal effects.`;

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

function cacheKey(celex, lang) {
  return `${String(celex || '').toUpperCase()}_${String(lang || 'ENG').toUpperCase()}`;
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

function findKnownCelex(label, actCelexMap = ACT_CELEX_MAP) {
  const text = String(label || '');
  if (!text) return null;
  for (const [alias, celex] of Object.entries(actCelexMap || {})) {
    if (!celex) continue;
    if (alias.includes('/') && text.toLowerCase().includes(alias.toLowerCase())) {
      return celex;
    }
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9/])${escaped}([^A-Za-z0-9/]|$)`, 'i').test(text)) {
      return celex;
    }
  }
  return null;
}

function buildRelatedInstrumentCandidates(crossReferences, actCelexMap = ACT_CELEX_MAP) {
  const candidates = new Map();
  for (const refs of Object.values(crossReferences || {})) {
    for (const ref of refs || []) {
      if (ref?.type !== 'external' && ref?.type !== 'oj_ref') continue;
      const label = ref.raw || ref.target;
      if (!label) continue;
      const key = ref.type === 'oj_ref'
        ? `oj:${ref.ojColl || ''}:${ref.ojYear || ''}:${ref.ojNo || ''}`
        : `external:${ref.target || label}`;
      const celex = ref.celex || ref.actCelex || findKnownCelex(label, actCelexMap);
      const existing = candidates.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        candidates.set(key, {
          key,
          label,
          celex,
          type: ref.type,
          count: 1,
        });
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, MAX_RELATED_CANDIDATES);
}

function buildSkeleton(articles) {
  return (articles || []).map((article) => ({
    number: String(article.article_number || '').trim(),
    title: article.article_title || null,
    chapter: article.division?.chapter?.title || null,
    section: article.division?.section?.title || null,
  })).filter((article) => article.number);
}

function buildLawSummaryInput(parsedLaw, { actCelexMap = ACT_CELEX_MAP } = {}) {
  const articles = (parsedLaw.articles || [])
    .map((article) => ({
      number: String(article.article_number || '').trim(),
      title: article.article_title || null,
      chapter: article.division?.chapter?.title || null,
      section: article.division?.section?.title || null,
      text: clip(article.article_text || article.article_html || '', MAX_ARTICLE_TEXT_CHARS),
    }))
    .filter((article) => article.number && article.text);

  return {
    celex: parsedLaw.celex || null,
    lang: parsedLaw.lang || parsedLaw.langCode || null,
    title: parsedLaw.title || parsedLaw.doc_title || parsedLaw.name || null,
    eli: parsedLaw.eli || null,
    source: parsedLaw.source || null,
    skeleton: buildSkeleton(parsedLaw.articles || []),
    definitions: (parsedLaw.definitions || [])
      .map((definition) => ({
        term: definition.term,
        sourceArticle: definition.sourceArticle || definition.source_article || null,
      }))
      .filter((definition) => definition.term),
    recitals: (parsedLaw.recitals || []).slice(0, 8).map((recital) => ({
      number: String(recital.recital_number || '').trim(),
      text: clip(recital.recital_text || recital.recital_html || '', MAX_RECITAL_TEXT_CHARS),
    })).filter((recital) => recital.number && recital.text),
    articles,
    relatedInstrumentCandidates: buildRelatedInstrumentCandidates(parsedLaw.crossReferences || {}, actCelexMap),
  };
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Summary model did not return a JSON object');
  return JSON.parse(match[0]);
}

function normalizeCitations(value, validArticles) {
  const values = Array.isArray(value) ? value : [];
  return Array.from(new Set(values
    .map((citation) => String(citation || '').replace(/^Art\.?\s*/i, '').trim())
    .filter((citation) => validArticles.has(citation))));
}

function normalizeText(value, maxChars = 1200) {
  const text = stripTags(value);
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
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

function normalizeRelatedInstruments(value, candidates) {
  const candidateByCelex = new Map();
  const candidateByLabel = new Map();
  for (const candidate of candidates || []) {
    if (candidate.celex) candidateByCelex.set(candidate.celex, candidate);
    candidateByLabel.set(String(candidate.label).toLowerCase(), candidate);
  }

  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const label = normalizeText(entry.label, 220);
      const celex = normalizeText(entry.celex, 40) || null;
      const relationship = normalizeText(entry.relationship, 320);
      const candidate = (celex && candidateByCelex.get(celex))
        || candidateByLabel.get(label.toLowerCase());
      if (!label || !relationship || !candidate) return null;
      return {
        label: candidate.label,
        celex: candidate.celex || celex || null,
        relationship,
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function parseLawSummaryJson(text, input) {
  const parsed = extractJsonObject(text);
  const validArticles = new Set((input.articles || []).map((article) => String(article.number)));
  const purpose = normalizeCitedBlock(parsed.purpose, validArticles);
  const scope = normalizeCitedBlock(parsed.scope, validArticles, { requireCitation: true });
  const keyObligations = (Array.isArray(parsed.keyObligations) ? parsed.keyObligations : [])
    .map((item) => normalizeCitedBlock(item, validArticles, { requireCitation: true }))
    .filter(Boolean)
    .slice(0, 8);
  const structure = normalizeText(parsed.structure, 1000);
  const relatedInstruments = normalizeRelatedInstruments(parsed.relatedInstruments, input.relatedInstrumentCandidates || []);

  if (!purpose?.text) throw new Error('Summary is missing purpose');
  if (!scope?.text) throw new Error('Summary is missing cited scope');
  if (keyObligations.length === 0) throw new Error('Summary is missing cited key obligations');
  if (!structure) throw new Error('Summary is missing structure');

  return {
    purpose,
    scope,
    keyObligations,
    structure,
    relatedInstruments,
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
    },
    articleIndex: input.skeleton,
    definitions: input.definitions,
    openingRecitals: input.recitals,
    articles: input.articles,
    relatedInstrumentCandidates: input.relatedInstrumentCandidates,
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
    maxTokens: 2400,
    responseFormat: 'json_object',
    reasoning: { max_tokens: 256, exclude: true },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });

  return {
    summary: parseLawSummaryJson(response.text, input),
    model: response.model || model,
    usage: response.usage || null,
  };
}

async function ensureLawSummary({
  celex,
  lang,
  parsedLaw,
  cacheDir,
  apiKey,
  model,
  chatComplete: chatCompleteImpl = chatComplete,
} = {}) {
  const input = buildLawSummaryInput(parsedLaw);
  const sourceHash = stableHash(input);
  const key = cacheKey(celex || input.celex, lang || input.lang);

  return withSingleFlight(`law-summary:${key}:${sourceHash}:${model}`, async () => {
    const cache = cacheDir ? loadCache(cacheDir) : {};
    const cached = cache[key];
    if (
      cached?.version === CACHE_VERSION
      && cached?.schemaVersion === SCHEMA_VERSION
      && cached?.promptVersion === PROMPT_VERSION
      && cached?.sourceHash === sourceHash
      && cached?.model === model
      && cached?.summary
    ) {
      return {
        summary: cached.summary,
        model: cached.model,
        generatedAt: cached.generatedAt || null,
        cached: true,
      };
    }

    const generated = await generateLawSummary(input, { apiKey, model, chatComplete: chatCompleteImpl });
    if (cacheDir) {
      cache[key] = {
        version: CACHE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        promptVersion: PROMPT_VERSION,
        sourceHash,
        model: generated.model || model,
        generatedAt: new Date().toISOString(),
        summary: generated.summary,
      };
      saveCache(cacheDir, cache);
    }

    return {
      summary: generated.summary,
      model: generated.model || model,
      usage: generated.usage || null,
      generatedAt: cache[key]?.generatedAt || null,
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
  generateLawSummary,
  parseLawSummaryJson,
};
