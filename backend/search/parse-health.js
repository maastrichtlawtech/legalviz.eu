"use strict";

// Parse-health signals: contradictions a parsed act carries against itself.
//
// Parser gaps in this codebase fail silently — nothing throws, the law renders,
// a section is just quietly empty or wrong (see issue #142, and the #140/#141
// failures that motivated it). The checks here need no expected-value table and
// no maintained baseline: each one is a statement the document makes about
// itself that the parse output contradicts. An article titled "Definitions"
// that yields none; a recital numbered 44 in an act that parsed 30 recitals;
// the same recital number twice.
//
// This module is the single definition of those signals. It is consumed by
// three layers, deliberately: shared/corpus-fixtures.test.js (frozen fixtures,
// runs in CI without a corpus), search/corpus-health.test.js (sampled sweep,
// skips when the local corpus is absent) and search/corpus-reference-audit.js
// (exhaustive worker-recycled sweep). Keep the signals here rather than in any
// one caller — they drifted as copy-paste between two of them before.
//
// Counters are additive so a caller can merge them across a corpus; `signals`
// carries un-prefixed human-readable descriptions that a caller labels with the
// file it was scanning.

const { getLangConfig } = require("../shared/formex-parser/languages.mjs");

// Keep the malformed-term test deliberately structural. A point marker, bullet,
// or finite-verb clause at the start of a defined term means the parser
// consumed surrounding prose instead of a noun phrase — the 95/46 "the purposes
// and means of the processing…" failure. Do NOT replace this with a word-count
// cutoff: measured against the corpus, a raw ">10 words" rule is roughly 50%
// false positives, because legitimate multilingual terms are long (e.g.
// 31993L0016's "diplôme légal de docteur en médecine, chirurgie et
// accouchements/Wettelijk diploma van doctor…").
const DEFINITION_POINT_SHAPE = /^\(?\s*(?:[a-z]{1,2}|\d{1,3})\s*[).]\s+/i;
const DEFINITION_DASH_SHAPE = /^[-‐-―]\s*/;
const DEFINITION_VERB_SHAPE = /^(?:\S+\s+){1,}\b(?:is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|shall|should|may|might|must|will|would|means?|includes?|consists?|concerns?|applies?|defines?|refers?|provides?|requires?|states?|ensures?|establishes?|determines?|represents?|covers?|specifies?|indicates?|allows?|prohibits?|permits?|entails?|follows?)\b/i;

// An act whose "Definitions" article only cross-refers to another act's
// definitions ("the definitions in Directive 95/46/EC shall apply") correctly
// yields nothing. That is the one legitimate shape behind this signal's false
// positives, and unlike the open-ended class the issue feared, it announces
// itself in the article body. Recognising it here keeps the zero-definitions
// signal assertable without an allow-list.
const CROSS_REFERRING_DEFINITIONS = /\bdefinitions?\b[\s\S]{0,200}?\b(?:in|of|laid\s+down\s+in|set\s+out\s+in|contained\s+in)\b[\s\S]{0,80}?\b(?:Directive|Regulation|Decision|Treaty|Article)\b/i;

// A definitions article may import another act's vocabulary and still add
// definitions of its own. Do not let the imported sentence exempt the whole
// article when local definition language remains; that would hide precisely
// the mixed-content parser gap this check is meant to surface.
const LOCAL_DEFINITION_CLAUSE = /\b(?:means?|includes?|shall\s+(?:mean|be\s+understood\s+as)|is\s+defined\s+as)\b|["'‘’“”«»][^"'‘’“”«»]{1,200}["'‘’“”«»]\s*:/i;

// Below this, an act with no articles is plausibly a stub or a repealing note
// rather than a segmentation failure. 32004D0464 (3.4 kB of body, 0 articles)
// is the shape this is sized for.
const MIN_ARTICLELESS_BODY_CHARS = 500;

function isMalformedDefinitionTerm(term) {
  const value = String(term || "").trim();
  return DEFINITION_POINT_SHAPE.test(value)
    || DEFINITION_DASH_SHAPE.test(value)
    || DEFINITION_VERB_SHAPE.test(value);
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function onlyCrossRefersToDefinitions(text) {
  return CROSS_REFERRING_DEFINITIONS.test(text) && !LOCAL_DEFINITION_CLAUSE.test(text);
}

function bodyTextLength(parsed) {
  const blocks = [
    ...(parsed.articles || []).map((article) => article.article_html || article.article_text),
    ...(parsed.recitals || []).map((recital) => recital.recital_html || recital.recital_text),
    ...(parsed.annexes || []).map((annex) => annex.annex_html || annex.annex_text),
  ];
  return blocks.reduce((total, block) => total + stripHtml(block).length, 0);
}

// Recital numbering in EU acts is dense and 1-based wherever it is numeric at
// all. Unnumbered "Whereas …" runs are given synthetic sequential numbers by
// both parsers, so they stay dense too. Anything non-numeric (or an act with no
// recitals) is not a signal — return null rather than guess.
function recitalNumbering(parsed) {
  const recitals = parsed.recitals || [];
  if (!recitals.length) return null;
  const numbers = [];
  for (const recital of recitals) {
    const digits = String(recital.recital_number ?? "").replace(/\D+/g, "");
    if (!digits) return null;
    const value = Number.parseInt(digits, 10);
    if (!Number.isFinite(value) || value <= 0) return null;
    numbers.push(value);
  }
  return numbers;
}

function emptyHealth() {
  return {
    definitions: 0,
    definitionArticles: 0,
    definitionArticlesWithoutDefinitions: 0,
    malformedDefinitionTerms: 0,
    recitalsDuplicated: 0,
    duplicateRecitalNumbers: 0,
    recitalsMissing: 0,
    missingRecitalNumbers: 0,
    articlelessWithBody: 0,
    signals: [],
  };
}

function inspectDefinitions(parsed, health) {
  const lang = getLangConfig(parsed.langCode || "EN");
  const definitionsByArticle = new Map();
  for (const definition of parsed.definitions || []) {
    const key = String(definition.sourceArticle);
    definitionsByArticle.set(key, (definitionsByArticle.get(key) || 0) + 1);
    health.definitions += 1;
    if (isMalformedDefinitionTerm(definition.term)) {
      health.malformedDefinitionTerms += 1;
      health.signals.push(`Article ${key}: malformed definition term ${JSON.stringify(definition.term)}`);
    }
  }

  for (const article of parsed.articles || []) {
    if (!lang.definition?.test(article.article_title || "")) continue;
    health.definitionArticles += 1;
    if (definitionsByArticle.has(String(article.article_number))) continue;
    if (onlyCrossRefersToDefinitions(stripHtml(article.article_html || article.article_text))) continue;
    health.definitionArticlesWithoutDefinitions += 1;
    health.signals.push(
      `Article ${article.article_number}: title declares definitions but none were extracted`,
    );
  }
}

function inspectRecitals(parsed, health) {
  const numbers = recitalNumbering(parsed);
  if (!numbers) return;

  const seen = new Set();
  const duplicates = new Set();
  for (const number of numbers) {
    if (seen.has(number)) duplicates.add(number);
    seen.add(number);
  }
  if (duplicates.size) {
    // Two counters per signal throughout: one act-level (how many acts trip it,
    // the useful denominator for a corpus rate) and one item-level (how badly).
    health.recitalsDuplicated += 1;
    health.duplicateRecitalNumbers += numbers.length - seen.size;
    // Two known causes, both real defects: a harvested capture holding the act
    // two or three times (the Cellar manifestation-URI duplication), and the
    // HTML parser emitting the same recital twice (the ETS Directive, #146).
    health.signals.push(
      `recital numbers repeat (${numbers.length} recitals, ${seen.size} distinct; e.g. ${[...duplicates].slice(0, 3).join(", ")})`,
    );
    return; // A duplicated capture makes the gap check below meaningless.
  }

  const highest = Math.max(...numbers);
  const missing = highest - numbers.length;
  if (missing > 0) {
    // The #140 direction: the act numbers a recital the parse never produced.
    health.recitalsMissing += 1;
    health.missingRecitalNumbers += missing;
    health.signals.push(
      `recitals numbered up to ${highest} but only ${numbers.length} parsed (${missing} missing)`,
    );
  }
}

function inspectSegmentation(parsed, health) {
  if ((parsed.articles || []).length) return;
  const bodyChars = bodyTextLength(parsed);
  if (bodyChars < MIN_ARTICLELESS_BODY_CHARS) return;
  health.articlelessWithBody += 1;
  health.signals.push(`no articles parsed from ${bodyChars} characters of body text`);
}

// Returns the counters plus un-prefixed signal descriptions for one parsed act.
function inspectParseHealth(parsed) {
  const health = emptyHealth();
  if (!parsed || typeof parsed !== "object") return health;
  inspectDefinitions(parsed, health);
  inspectRecitals(parsed, health);
  inspectSegmentation(parsed, health);
  return health;
}

const HEALTH_COUNTERS = Object.keys(emptyHealth()).filter((key) => key !== "signals");

// Merge one act's health into an accumulating corpus tally, labelling each
// signal with the file it came from and capping the sample list.
function mergeParseHealth(target, health, { label = "", maxSamples = 10, samplesKey = "signals" } = {}) {
  for (const key of HEALTH_COUNTERS) target[key] = (target[key] || 0) + (health[key] || 0);
  const samples = target[samplesKey] || (target[samplesKey] = []);
  for (const signal of health.signals || []) {
    if (samples.length >= maxSamples) break;
    samples.push(label ? `${label}: ${signal}` : signal);
  }
  return target;
}

module.exports = {
  HEALTH_COUNTERS,
  MIN_ARTICLELESS_BODY_CHARS,
  emptyHealth,
  inspectParseHealth,
  isMalformedDefinitionTerm,
  mergeParseHealth,
  recitalNumbering,
};
