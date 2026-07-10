const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Shared helpers for the OpenRouter-backed "static" AI features (law summary,
// per-article case-law digest, whole-law case-law digest). Each feature keeps
// its own prompt, schema, cache filename, and validation; only the mechanical
// text/cache/citation plumbing lives here.

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

// Plain length cap used by the digest features. (The law summary uses its own
// sentence-boundary-aware clip, which lives in that service.)
function clip(value, maxChars) {
  const text = stripTags(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function normalizeText(value, maxChars = 1200) {
  const text = stripTags(value);
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Coalesce concurrent identical requests onto one in-flight promise.
function makeSingleFlight() {
  const inFlight = new Map();
  return function withSingleFlight(key, factory) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve()
      .then(factory)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}

function loadCache(cacheDir, cacheFile) {
  try {
    const filePath = path.join(cacheDir, cacheFile);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(cacheDir, cacheFile, cache) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, cacheFile);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
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

// Index the case-law input by ECLI and CELEX so model-produced citations can be
// grounded back to a judgment (and its valid declaration numbers) that actually
// appeared in the prompt.
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

// Keep only citations the model could have grounded in the input, normalising
// declaration numbers to those present for the matched judgment.
function normalizeCites(value, input, { limit = 6 } = {}) {
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
        caseNumber: source.caseNumber || null,
        name: source.name || null,
        declarationNumber: normalizedDeclaration,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

module.exports = {
  stripTags,
  clip,
  normalizeText,
  stableHash,
  makeSingleFlight,
  loadCache,
  saveCache,
  extractJsonObject,
  buildCitationIndex,
  normalizeCites,
};
