# LLM-Assisted Article Q&A — Design Plan

> Per-article free-form Q&A is paused; see the static law-summary and article case-law digest migration.

Captures the design for a v1 question-answering panel that helps a user
understand a single article of an EU law, grounded in the law's own
structure and in CJEU case law interpreting it.

This is **not** a chat-with-PDF clone. The point is that the tool already
extracts the things that make legal answers defensible (structure,
definitions, cross-references, operative parts of judgments with
article-level citations), so the retrieval step is largely structural
rather than semantic.

---

## 1. Scope (v1)

- **One article at a time.** User is reading Article X of law L; a panel
  offers "Explain / Ask about this article." Cross-law Q&A is explicitly
  out of scope for v1.
- **One law to start.** The case-law pre-compute and prompt evaluation are
  per-law. GDPR is the likely first target (dense, well-indexed case law,
  high user value); final choice TBD.
- **Grounded answers only.** Every claim must cite a bundle element by
  ID. Ungrounded answers are rejected at the prompt level and ideally
  also at a post-hoc validation step.

Out of scope for v1 (noted so we don't drift):

- Cross-law traversal (following Art. 4 → another regulation)
- Temporal validity signals ("is this judgment still good law?")
- Embeddings / vector DB
- Graph visualisation
- Multi-turn chat (v1 is single question → grounded answer)

---

## 2. User flow

1. User is reading Article X in the existing reader.
2. Clicks "Explain / Ask" on the article.
3. Either asks a free-form question, or picks a preset
   ("What does this article require?", "How has the CJEU interpreted
   this?", "Which other articles does this depend on?").
4. Backend assembles an **Article Bundle** (Section 3) and sends it to
   an LLM with a grounded prompt (Section 4).
5. LLM returns a structured answer; UI renders it with citation links
   back into the bundle (article numbers, recital numbers, ECLI + §).

---

## 3. Article Bundle

A pure data object, assembled deterministically from already-cached
sources. No LLM involvement in assembly.

```
buildArticleBundle(celex, articleNumber, lang) -> {
  article:   { number, title, paragraphs: [...] },
  skeleton:  [ { chapterNo, chapterTitle,
                 sections: [ { sectionNo, sectionTitle,
                                articles: [ { number, title, isFocus: bool } ] } ] } ],
  definitions: [ { term, text, sourceArticle } ],   // terms used in X, resolved to Art. 4-style
  recitals:    [ { number, text, matchScore } ],    // TF-IDF top-N for v1
  caseLaw:     [ { ecli, caseNumber, celex, date, name,
                   declarations: [ { number, text } ],   // operative part
                   matchingRefs: [ {article, paragraph, point} ] } ], // why this case is here
  meta: { celex, lang, generatedAt }
}
```

### Provenance of each piece

| Bundle field  | Source                                                 | Status        |
|---------------|--------------------------------------------------------|---------------|
| `article`     | Formex parser (`fmxParser.mjs`)                        | Exists        |
| `skeleton`    | Formex parser `<DIVISION>` tree                        | Exists        |
| `definitions` | Definitions parser (`fmxParser.mjs`, eurlex-html-parser) | Exists      |
| `recitals`    | TF-IDF recital→article matching                         | Exists (baseline) |
| `caseLaw`     | `law-queries.js` SPARQL + operative-part + article refs | Exists, article-linking being upgraded |

### Structural, not semantic

The bundle deliberately avoids embedding-based retrieval for v1:

- **Definitions**: exact structural link — every defined term used in X
  is resolved to its Art. 4-style entry. 100% precision.
- **Skeleton**: free from the Formex XML — chapter/subsection path and
  sibling article titles give the LLM the scaffolding a lawyer uses.
- **Case law**: filtered by structured `articleRefs` on each judgment
  (see Section 6). The operative parts (`declarations`) are what the
  Court actually held; we pass them verbatim with their ECLI and
  paragraph numbers.

The one fuzzy piece is recital matching — TF-IDF today, with a known
upgrade path (embeddings or curated mapping). Recitals are flat in EU
legislation and rarely cite articles by number, so there is no clean
structural shortcut there.

---

## 4. Prompt shape

The LLM receives the bundle as labelled sections and is instructed to:

1. Answer **only** what the bundle supports.
2. Cite every claim with a bundle ID:
   - `[Art. 5(1)(a)]` for statute
   - `[Recital 39]` for recitals
   - `[C-362/14 §73]` for CJEU paragraphs / declarations
3. If the bundle does not support an answer, say so and stop — do not
   speculate.
4. Distinguish *what the law says* from *how the CJEU has interpreted it*.

Skeleton (illustrative, not final):

```
SYSTEM: You are a legal-research assistant for EU law. You must only
answer based on the provided bundle. Every factual claim must be
followed by a citation using the bundle IDs. If the bundle does not
support an answer, say "The provided materials do not cover this."

USER:
[ARTICLE]
Art. 6 GDPR — Lawfulness of processing
<paragraph-structured text>

[LAW SKELETON]
Chapter II — Principles
  Art. 5 — Principles relating to processing
  Art. 6 — Lawfulness of processing   ← focus
  Art. 7 — Conditions for consent
  ...

[DEFINITIONS USED]
"personal data": Art. 4(1) — ...
"processing": Art. 4(2) — ...

[RELATED RECITALS]
Recital 40: ...
Recital 47: ...

[CJEU CASE LAW (article-level matches)]
C-252/21 Meta Platforms (2023-07-04)
  Declarations:
    1. ...
  Matching refs: Art. 6(1)(a), Art. 6(1)(b)
...

[QUESTION]
<user question>
```

---

## 5. Retrieval pipeline

```
(celex, articleNumber)
   ├── parsed law (cached)
   │     ├── article text + paragraph structure
   │     ├── skeleton (chapter/section/article tree)
   │     └── definitions (flat list)
   │
   ├── case-law cache (per-law, pre-computed)
   │     └── filter judgments where articleRefs matches articleNumber
   │
   └── recital index (TF-IDF, existing)
         └── top-N recitals for the article text
```

No network call at request time beyond whatever caching layer already
exists. The assembler is a pure read over caches.

---

## 6. Blocker being addressed in this branch

Empirical test against `api.legalviz.eu/api/laws/32016R0679/case-law`
(71 cases, April 2026):

- 70 / 71 cases have extracted operative parts and article citations —
  good overall coverage.
- Only **63 of 99 GDPR articles** have any citing case; several
  high-value articles (Art. 8 child consent, Art. 20 portability,
  Art. 35 DPIA, Art. 47 BCRs) are missing citing cases they almost
  certainly have in reality.

Two root causes:

1. **Composite citation strings are not split.** The extractor stores
   `"Art. 5, 6 and 10 GDPR"` as one string. Any naive per-article
   filter (`articlesCited.includes("Art. 6 GDPR")`) silently drops it.
2. **Act codes are not normalised.** The same corpus uses `GDPR`,
   `2016/679`, `95/46`, `2016/680`, `Charter`, `TFEU`, `ECHR` — some by
   nickname, some by year/number. This hurts cross-law filtering.

Fix in this branch: emit a parallel structured field on each judgment
(no frontend breakage — existing `articlesCited` pill strings stay):

```
articleRefs: [
  { raw: "Art. 6(1)(a) GDPR", act: "GDPR", actCelex: "32016R0679",
    article: "6", paragraph: "1", point: "a" },
  { raw: "Art. 5, 6 and 9 2002/58", act: "2002/58", actCelex: "32002L0058",
    article: "9", paragraph: null, point: null },
  ...
]
```

- Composite strings (`"Art. 5, 6 and 10 GDPR"`) are split into one ref
  per article.
- Composite strings (`"Art. 5, 6 and 10 GDPR"`) are split into one ref
  per article.
- `ACT_CELEX_MAP` covers GDPR, 95/46, 2002/58, 2016/680, DSA, DMA,
  AI Act, Charter, TFEU, and TEU; unknown acts keep `actCelex: null`.
- Cache bumped `v3 → v4`; on first load, existing v3 entries are
  migrated in-memory by parsing `articlesCited` and written out as v4.

Downstream: the bundle assembler filters by
`articleRefs.some(r => r.actCelex === celex && r.article === articleNumber)`,
giving reliable per-article case-law retrieval with no recall loss
from composite strings.

---

## 7. Cross-law case-law coverage (empirical, April 2026)

Tested against `api.legalviz.eu` for four laws:

| Law | Cases (citing) | Articles reachable | Composite-recall gain |
|-----|---------------|-------------------|----------------------|
| GDPR (2016/679) | 70 / 71 | 63 / 99 | Art. 5 +14, Art. 6 +12, Art. 82 +6 |
| ePrivacy (2002/58) | 21 / 23 | 10 / 21 | **Art. 9 +6**, Art. 6 +2, Art. 5 +1 |
| 95/46 (old DPD) | 34 / 35 | 27 / 34 | Art. 13 +1 (already dense) |
| LED (2016/680) | 8 / 9 | 25 / 65 | none (no composites) |
| DSA (2022/2065) | 0 | — | no CJEU case law yet |

**ePrivacy Art. 9 +6** is the clearest illustration of the value: seven
foundational data-retention judgments (Quadrature du Net ×2, Privacy
International, Bonnier, Prokuratuur, G.D., A.G.) all cite the composite
`"Art. 5, 6 and 9 2002/58"`, so they were entirely invisible to Art. 9
before the structured parser.

**Implications for target law choice:**

- GDPR and ePrivacy both have enough case law density for a strong v1.
  ePrivacy is actually a useful *simpler* test (21 articles vs 99) for
  validating the Q&A pipeline end-to-end before scaling to GDPR.
- 95/46 is useful as a *companion* to GDPR: the Court often interprets
  GDPR concepts against their 95/46 origins, so many GDPR article
  bundles will benefit from 95/46 case law automatically.
- LED (2016/680) and DSA/DMA/AI Act are viable structurally but have
  thin or no case law; the panel needs an explicit "no CJEU case law
  yet for this article" state.

---

## 8. Open decisions

Before building the bundle assembler, LLM integration, and UI:

1. **Target law for v1.** GDPR (recommended); ePrivacy is a faster
   end-to-end smoke-test. DSA/DMA/AI Act need graceful no-case-law
   fallback.
2. **LLM call location.** Backend with a server-held Anthropic key
   (simplest, we pay the bill), or user-supplied key relayed through
   the backend (privacy-friendly, no server cost, but adds BYO-key UX)?
3. **Evaluation set.** We will need a small hand-curated Q&A set per
   target law to measure grounding quality and catch prompt
   regressions. ~20 Q&A pairs is enough for a signal.

---

## 9. Build order after this branch

1. ~~Structured `articleRefs` + cache migration + cross-law ACT_CELEX_MAP~~ (this branch)
2. `buildArticleBundle(celex, articleNumber, lang)` — pure assembler
3. `POST /api/laws/:celex/articles/:n/ask` — bundle + LLM call
4. Frontend "Explain / Ask" panel on the article view
5. Eval harness with a fixed question set; track grounding rate and
   citation correctness across prompt changes

Non-goals that are likely to be tempting but should wait:

- Vector DB / embeddings — revisit only if TF-IDF recital matching
  proves to be the weakest link after user testing.
- Cross-law traversal — expand the bundle to follow cross-references
  only once single-law Q&A is solid and has an eval set.
- Multi-turn chat — a single grounded answer is more auditable and a
  better v1 unit of evaluation.
