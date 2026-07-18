const crypto = require('crypto');

const { chatComplete } = require('./openrouter-chat');
const { loadCache, saveCacheEntry, makeSingleFlight } = require('./ai-digest-utils');

const CACHE_FILE = 'recital-title-cache-v1.json';
const CACHE_VERSION = 2;
const MAX_RECITAL_TEXT_CHARS = 900;
const MAX_TITLE_CHARS = 90;
const RECITAL_TITLE_BATCH_SIZE = 35;

const SYSTEM_PROMPT = `You write short descriptive titles for recitals in EU legal acts.

Rules:
- Return ONLY a JSON object mapping each recital number to a title.
- Write titles in the same language as the recital text.
- Each title must be 3-8 words, specific, and readable.
- Do not include "Recital", article references, quotation marks, trailing punctuation, or legal citations.
- Avoid generic boilerplate such as "Purpose of this Regulation", "General provisions", or "Background".`;

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.;:,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function contentHash(recitals) {
  const hash = crypto.createHash('sha256');
  for (const recital of recitals || []) {
    hash.update(String(recital.recital_number || ''));
    hash.update('\0');
    hash.update(stripTags(recital.recital_text || recital.recital_html || ''));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function cacheKey(celex, lang) {
  return `${String(celex || '').toUpperCase()}_${String(lang || 'ENG').toUpperCase()}`;
}

function hasTitles(titles) {
  return titles && typeof titles === 'object' && Object.keys(titles).length > 0;
}

function responseSnippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function buildUserPrompt({ celex, lang, recitals }) {
  const lines = [
    `[LAW] ${celex}`,
    `[LANGUAGE] ${lang}`,
    '',
    '[RECITALS]',
  ];

  for (const recital of recitals || []) {
    const number = String(recital.recital_number || '').trim();
    const text = stripTags(recital.recital_text || recital.recital_html || '');
    if (!number || !text) continue;
    const clipped = text.length > MAX_RECITAL_TEXT_CHARS
      ? `${text.slice(0, MAX_RECITAL_TEXT_CHARS).trim()}...`
      : text;
    lines.push(`${number}: ${clipped}`);
  }

  return lines.join('\n');
}

function parseTitleJson(text, validNumbers) {
  const trimmed = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return {};

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {};
  }

  const valid = new Set(validNumbers.map(String));
  const titles = {};
  for (const [number, title] of Object.entries(parsed || {})) {
    const normalizedNumber = String(number).trim();
    if (!valid.has(normalizedNumber)) continue;
    const normalizedTitle = normalizeTitle(title);
    if (normalizedTitle) titles[normalizedNumber] = normalizedTitle;
  }
  return titles;
}

async function generateRecitalTitles({ celex, lang, recitals, apiKey, model }) {
  const validRecitals = (recitals || [])
    .filter((r) => String(r.recital_number || '').trim());
  if (validRecitals.length === 0) return {};

  const titles = {};
  for (let index = 0; index < validRecitals.length; index += RECITAL_TITLE_BATCH_SIZE) {
    const batch = validRecitals.slice(index, index + RECITAL_TITLE_BATCH_SIZE);
    const validNumbers = batch.map((r) => String(r.recital_number || '').trim()).filter(Boolean);
    const response = await chatComplete({
      model,
      apiKey,
      temperature: 0.1,
      maxTokens: Math.min(4000, Math.max(1200, validNumbers.length * 45)),
      responseFormat: 'json_object',
      reasoning: { max_tokens: 256, exclude: true },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt({ celex, lang, recitals: batch }) },
      ],
    });

    const batchTitles = parseTitleJson(response.text, validNumbers);
    if (!hasTitles(batchTitles)) {
      const snippet = responseSnippet(response.text);
      throw new Error(`Recital title model returned no valid titles for batch ${index + 1}-${index + batch.length}; finish=${response.finishReason || 'unknown'}; text=${snippet || '<empty>'}`);
    }
    Object.assign(titles, batchTitles);
  }

  return titles;
}

const withSingleFlight = makeSingleFlight();

async function ensureRecitalTitles({ celex, lang, recitals, cacheDir, apiKey, model }) {
  const hash = contentHash(recitals);
  const key = cacheKey(celex, lang);
  // Coalesce concurrent misses onto one in-flight generation: without this, N
  // simultaneous requests for the same uncached law each paid the full batch
  // of model calls (this service predates the shared digest plumbing).
  return withSingleFlight(`${key}:${hash}:${model || ''}`, async () => {
    const cache = cacheDir ? loadCache(cacheDir, CACHE_FILE) : {};
    const cached = cache[key];

    if (
      cached?.version === CACHE_VERSION
      && cached?.contentHash === hash
      && cached?.model === model
      && hasTitles(cached?.titles)
    ) {
      return {
        titles: cached.titles,
        model: cached.model || null,
        cached: true,
      };
    }

    const titles = await generateRecitalTitles({ celex, lang, recitals, apiKey, model });

    if (cacheDir) {
      try {
        // Atomic merge-on-save via the shared helper: a crash mid-write can no
        // longer corrupt the whole cache file, and a concurrent write for a
        // different law is no longer silently discarded.
        saveCacheEntry(cacheDir, CACHE_FILE, key, {
          version: CACHE_VERSION,
          contentHash: hash,
          model,
          generatedAt: new Date().toISOString(),
          titles,
        });
      } catch {
        // best-effort cache
      }
    }

    return { titles, model, cached: false };
  });
}

/**
 * Read cached recital titles without ever generating (no OpenRouter call).
 * Returns the cached titles only when they match the current recital content
 * (same version + content hash), regardless of which model produced them.
 * Used by the MCP `get_law_part` structure view, which must never block on or
 * pay for generation.
 */
function getCachedRecitalTitles({ celex, lang, recitals, cacheDir }) {
  if (!cacheDir) return { titles: {}, cached: false };
  const hash = contentHash(recitals);
  const key = cacheKey(celex, lang);
  const cache = loadCache(cacheDir, CACHE_FILE);
  const cached = cache[key];

  if (
    cached?.version === CACHE_VERSION
    && cached?.contentHash === hash
    && hasTitles(cached?.titles)
  ) {
    return { titles: cached.titles, model: cached.model || null, cached: true };
  }

  return { titles: {}, cached: false };
}

module.exports = {
  ensureRecitalTitles,
  generateRecitalTitles,
  getCachedRecitalTitles,
  parseTitleJson,
};
