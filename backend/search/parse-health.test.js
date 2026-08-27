"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HEALTH_COUNTERS,
  MIN_ARTICLELESS_BODY_CHARS,
  emptyHealth,
  inspectParseHealth,
  isMalformedDefinitionTerm,
  mergeParseHealth,
  recitalNumbering,
} = require("./parse-health");

const EMPTY_HEALTH = {
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

test("empty health has the complete counter shape", () => {
  assert.deepEqual(emptyHealth(), EMPTY_HEALTH);
  assert.deepEqual(HEALTH_COUNTERS, [
    "definitions",
    "definitionArticles",
    "definitionArticlesWithoutDefinitions",
    "malformedDefinitionTerms",
    "recitalsDuplicated",
    "duplicateRecitalNumbers",
    "recitalsMissing",
    "missingRecitalNumbers",
    "articlelessWithBody",
  ]);
});

test("a clean act has no parse-health signals", () => {
  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{ article_number: "1", article_title: "Scope", article_text: "This act applies." }],
    definitions: [],
    recitals: [],
  });

  assert.deepEqual(health, EMPTY_HEALTH);
  assert.equal(health.signals.length, 0);
});

test("a Definitions article signals when no definitions were extracted", () => {
  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{ article_number: "1", article_title: "Definitions", article_text: "This Article sets out terms." }],
    definitions: [],
  });

  assert.equal(health.definitionArticles, 1);
  assert.equal(health.definitionArticlesWithoutDefinitions, 1);
  assert.equal(health.signals.length, 1);
  assert.equal(health.signals[0], "Article 1: title declares definitions but none were extracted");
});

test("a Definitions article with an extracted definition is clean", () => {
  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{ article_number: "1", article_title: "Definitions", article_text: "Terms used in this act." }],
    definitions: [{ sourceArticle: "1", term: "controller", definition: "a natural or legal person" }],
  });

  assert.deepEqual(health, {
    ...EMPTY_HEALTH,
    definitions: 1,
    definitionArticles: 1,
  });
  assert.equal(health.signals.length, 0);
});

test("a Definitions article that cross-refers to another act is exempt", () => {
  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{
      article_number: "2",
      article_title: "Definitions",
      article_text: "The definitions in Directive 95/46/EC shall apply.",
    }],
    definitions: [],
  });

  assert.equal(health.definitionArticles, 1);
  assert.equal(health.definitionArticlesWithoutDefinitions, 0);
  assert.equal(health.signals.length, 0);
});

test("a Definitions article that imports and adds definitions is not exempt", () => {
  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{
      article_number: "2",
      article_title: "Definitions",
      article_text: "The definitions in Directive 95/46/EC shall apply. In addition, 'service provider' means a natural or legal person.",
    }],
    definitions: [],
  });

  assert.equal(health.definitionArticles, 1);
  assert.equal(health.definitionArticlesWithoutDefinitions, 1);
  assert.equal(health.signals.length, 1);
  assert.equal(health.signals[0], "Article 2: title declares definitions but none were extracted");
});

test("German Begriffsbestimmungen is recognized as a definition article", () => {
  const health = inspectParseHealth({
    langCode: "DE",
    articles: [{ article_number: "1", article_title: "Begriffsbestimmungen", article_text: "Für diese Verordnung gilt:" }],
    definitions: [],
  });

  assert.equal(health.definitionArticles, 1);
  assert.equal(health.definitionArticlesWithoutDefinitions, 1);
  assert.equal(health.signals.length, 1);
  assert.match(health.signals[0], /Article 1: title declares definitions/);
});

test("malformed definition terms produce one signal each", () => {
  const terms = [
    "(a) point-marked term",
    "- dashed term",
    "the purposes and means of the processing of personal data",
  ];
  for (const term of terms) assert.equal(isMalformedDefinitionTerm(term), true);

  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{ article_number: "1", article_title: "Definitions", article_text: "Terms." }],
    definitions: terms.map((term) => ({ sourceArticle: "1", term })),
  });

  assert.equal(health.definitions, 3);
  assert.equal(health.malformedDefinitionTerms, 3);
  assert.equal(health.signals.length, 3);
  assert.deepEqual(health.signals, terms.map((term) => `Article 1: malformed definition term ${JSON.stringify(term)}`));
});

test("long legitimate multilingual terms, including personal data, are not malformed", () => {
  const terms = [
    // The real 31993L0016 term. A word-count rule would flag this; the shape
    // rules deliberately do not, which is the point of the negative case.
    "diplôme légal de docteur en médecine, chirurgie et accouchements/Wettelijk diploma van doctor in de geneeskunde, heelkunde en verloskunde",
    "personal data",
  ];
  for (const term of terms) assert.equal(isMalformedDefinitionTerm(term), false);

  const health = inspectParseHealth({
    langCode: "EN",
    articles: [{ article_number: "1", article_title: "Definitions", article_text: "Terms." }],
    definitions: terms.map((term) => ({ sourceArticle: "1", term })),
  });

  assert.equal(health.definitions, 2);
  assert.equal(health.malformedDefinitionTerms, 0);
  assert.equal(health.signals.length, 0);
});

test("duplicate recital numbers count acts and duplicate items", () => {
  const parsed = { recitals: [
    { recital_number: "1" },
    { recital_number: "2" },
    { recital_number: "1" },
    { recital_number: "2" },
  ] };

  assert.deepEqual(recitalNumbering(parsed), [1, 2, 1, 2]);
  const health = inspectParseHealth(parsed);

  assert.equal(health.recitalsDuplicated, 1);
  assert.equal(health.duplicateRecitalNumbers, 2);
  assert.equal(health.recitalsMissing, 0);
  assert.equal(health.missingRecitalNumbers, 0);
  assert.equal(health.signals.length, 1);
  assert.equal(health.signals[0], "recital numbers repeat (4 recitals, 2 distinct; e.g. 1, 2)");
  assert.match(health.signals[0], /recital numbers repeat/);
});

test("missing recital number 3 is counted when 1, 2, and 4 are parsed", () => {
  const parsed = { recitals: [
    { recital_number: "1" },
    { recital_number: "2" },
    { recital_number: "4" },
  ] };

  assert.deepEqual(recitalNumbering(parsed), [1, 2, 4]);
  const health = inspectParseHealth(parsed);

  assert.equal(health.recitalsDuplicated, 0);
  assert.equal(health.duplicateRecitalNumbers, 0);
  assert.equal(health.recitalsMissing, 1);
  assert.equal(health.missingRecitalNumbers, 1);
  assert.equal(health.signals.length, 1);
  assert.equal(health.signals[0], "recitals numbered up to 4 but only 3 parsed (1 missing)");
  assert.match(health.signals[0], /1 missing/);
});

test("recital numbering is null and silent for absent or non-numeric recitals", () => {
  for (const parsed of [
    { recitals: [] },
    { recitals: [{ recital_number: "Whereas" }] },
  ]) {
    assert.equal(recitalNumbering(parsed), null);
    const health = inspectParseHealth(parsed);
    assert.deepEqual(health, EMPTY_HEALTH);
    assert.equal(health.signals.length, 0);
  }
});

test("articleless acts signal only at the exported body-length threshold", () => {
  const longHealth = inspectParseHealth({
    articles: [],
    recitals: [],
    annexes: [{ annex_text: "x".repeat(MIN_ARTICLELESS_BODY_CHARS + 1) }],
  });
  assert.equal(longHealth.articlelessWithBody, 1);
  assert.equal(longHealth.signals.length, 1);
  assert.equal(longHealth.signals[0], `no articles parsed from ${MIN_ARTICLELESS_BODY_CHARS + 1} characters of body text`);
  assert.match(longHealth.signals[0], /no articles parsed from/);

  const shortHealth = inspectParseHealth({
    articles: [],
    recitals: [],
    annexes: [{ annex_text: "x".repeat(MIN_ARTICLELESS_BODY_CHARS - 1) }],
  });
  assert.equal(shortHealth.articlelessWithBody, 0);
  assert.equal(shortHealth.signals.length, 0);
  assert.deepEqual(shortHealth, EMPTY_HEALTH);
});

test("mergeParseHealth sums counters, prefixes signals, and caps samples", () => {
  const first = {
    definitions: 2,
    definitionArticles: 1,
    definitionArticlesWithoutDefinitions: 1,
    malformedDefinitionTerms: 3,
    recitalsDuplicated: 1,
    duplicateRecitalNumbers: 2,
    recitalsMissing: 0,
    missingRecitalNumbers: 0,
    articlelessWithBody: 1,
    signals: ["first signal", "second signal"],
  };
  const second = {
    definitions: 1,
    definitionArticles: 2,
    definitionArticlesWithoutDefinitions: 0,
    malformedDefinitionTerms: 1,
    recitalsDuplicated: 0,
    duplicateRecitalNumbers: 0,
    recitalsMissing: 1,
    missingRecitalNumbers: 2,
    articlelessWithBody: 0,
    signals: ["third signal", "fourth signal"],
  };

  const merged = mergeParseHealth(emptyHealth(), first, { label: "first.xml", maxSamples: 3 });
  mergeParseHealth(merged, second, { label: "second.xml", maxSamples: 3 });

  assert.deepEqual(merged, {
    definitions: 3,
    definitionArticles: 3,
    definitionArticlesWithoutDefinitions: 1,
    malformedDefinitionTerms: 4,
    recitalsDuplicated: 1,
    duplicateRecitalNumbers: 2,
    recitalsMissing: 1,
    missingRecitalNumbers: 2,
    articlelessWithBody: 1,
    signals: ["first.xml: first signal", "first.xml: second signal", "second.xml: third signal"],
  });
});

test("null and undefined parsed values return empty health", () => {
  assert.deepEqual(inspectParseHealth(null), EMPTY_HEALTH);
  assert.deepEqual(inspectParseHealth(undefined), EMPTY_HEALTH);
});
