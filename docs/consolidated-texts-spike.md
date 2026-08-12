# Spike: consolidated ("as amended") texts

Time-boxed investigation of item 1 in #135. Question: *is rendering consolidated
texts the cheap plumbing job the issue claims, and is the upstream data good
enough to build on?*

Everything below is a measurement, not an argument. Reproduce with
`node scripts/consolidated-texts-probe.mjs` from `backend/` (~12 min, needs
network; no API keys, no caches written). Numbers are from a run on 2026-08-12
against live Cellar, with the deployed `api.legalviz.eu` as the as-adopted side.

**Answers, in short.** The data is good — better than expected. The plumbing is
not cheap, but it is bounded and well understood. The reason to hesitate is
neither of those: it is that consolidated texts have **no recitals**, and for
heavily amended acts they are a **substantially different act** from the one the
rest of the app is indexed against.

---

## 1. Availability: better than the issue assumed

| act | amendments | versions | not yet applied | newest applied | uri shape |
|---|---:|---:|---:|---|---|
| GDPR | 0 | 1 | 0 | 2016-05-04 | `/celex/` |
| Digital Services Act | — | — | — | *406 from Cellar* | — |
| AI Act | 1 | 2 | 0 | 2026-07-27 | `/consolidation/` |
| Consumer Rights Directive | 4 | 4 | 1 | 2022-05-28 | `/consolidation/` |
| PSD2 | 2 | 3 | 0 | 2025-01-17 | `/consolidation/` |
| AML Directive 4 | 4 | 5 | 0 | 2024-12-30 | `/consolidation/` |
| CRR | 20 | 22 | 0 | 2026-06-26 | `/consolidation/` |
| CRD IV | 12 | 14 | 0 | 2026-07-11 | `/consolidation/` |
| VAT Directive | 32 | 31 | 0 | 2025-04-14 | `/consolidation/` |
| MiFID II | 12 | 14 | 0 | 2026-06-06 | `/consolidation/` |
| Solvency II | 12 | 14 | 1 | 2025-01-17 | `/consolidation/` |
| Waste Framework Directive | 6 | 6 | 0 | 2025-10-16 | `/consolidation/` |
| Emissions Trading Directive | 18 | 16 | 0 | 2024-03-01 | `/consolidation/` |
| REACH | 42 | 68 | 0 | 2026-05-11 | `/consolidation/` |

- **13 of 14 acts have consolidated Formex**, and every one of those parsed.
  Consolidation chains are long where it matters (REACH 68 versions, CRR 22),
  which is the opposite of the "there usually aren't super long consolidations"
  assumption — that holds only for young or lightly amended acts.
- **Consolidation is not stale.** In 12 of 13 cases the newest consolidated
  version is *newer* than the newest amending act. The one exception is the
  Consumer Rights Directive, where consolidation trails by 641 days. Whatever
  the risk of this feature is, serving out-of-date consolidations is not it.
- **Future-dated versions are real but rare**: 2 of 13 acts carry a
  consolidation dated after today. Any consumer must filter them or it will
  present a text that has not yet applied.
- **One act is indexed but unservable.** SPARQL lists `02022R2065-20221027` for
  the DSA; Cellar answers `406` for the resource, on every Accept header tried.
  That is the "Cellar data might be incomplete" concern, quantified at roughly
  1 in 14 — low, but non-zero, so the UI cannot assume a listed version resolves.

## 2. Plumbing: three concrete gaps, all small

**The parser already handles the body.** Consolidated Formex is a `<CONS.ACT>`
root wrapping the same `ENACTING.TERMS → DIVISION → ARTICLE → TI.ART/PARAG`
structure as an OJ act. `parseFmxToCombined` walks it unmodified and produced
plausible articles and definitions for all 13. No parser rewrite is implied.

**Gap 1 — `isFmxDocument` rejects every consolidated document** (all 13 rows
report `FAIL`). It requires the literal `<ACT`, which `<CONS.ACT` does not
contain. Worth being precise about where this bites: the backend `/parsed` route
never consults it (`parsed-law-service.js` parses whatever the FMX service
returned), so this blocks the **frontend** raw-XML path and cache validation
(`src/utils/parsers.js`, `formexApi.js:711`) only.

**Gap 2 — the manifestation URI shape.** `findFmx4Uri` in the serving path
(`fmx-service.js:97`) matches `/oj/…` only. Consolidated manifestations live at
`/resource/consolidation/<id>%2F<date>.ENG.fmx4`, or occasionally
`/resource/celex/…` (the GDPR). The generic `\.[A-Z]{3}\.fmx4$` matcher in
`search-build.js:236` already handles all three — the fix exists in the repo, it
just isn't in the path that serves readers.

**Gap 2a — the `/consolidation/` URI only appears with `Accept-Language`.**
Without that header Cellar returns a document listing no FMX manifestation at
all. The serving path already sends `Accept-Language: eng`; anything new must
not drop it, or consolidated acts will look like they have no Formex.

**Gap 3 — title extraction.** Consolidated files open with a `<GR.CORRIG>`
family block whose `<TITLE>` precedes the act's own, so a naive first-`TITLE`
read yields the corrigendum's title. (Not observed in the parsed output for the
sample, so the current traversal appears to avoid it — but it is a trap for any
new metadata code.)

## 2a. Cost per version: one file, not a chain

Worth stating explicitly, because the version counts above invite the opposite
assumption: **each consolidated version is a complete standalone document, not a
delta.** REACH's 68 versions are 68 independent snapshots of the whole act. To
render the current text you fetch exactly one of them, and nothing has to be
replayed in order.

Measured end-to-end for the newest applied version of three heavily amended
acts (resource RDF → manifestation RDF → payload):

| act | requests | payload | wall time |
|---|---:|---:|---:|
| CRR | 3 | 1.0 MB (zip) | 1.7 s |
| REACH | 3 | 0.6 MB (zip) | 1.2 s |
| VAT Directive | 3 | 0.1 MB (zip) | 1.1 s |

The two RDF hops are the same shape the FMX service already performs for
as-adopted acts, and the existing disk cache keys on CELEX, so a consolidated
id caches like any other. Large consolidated acts arrive as a single
`CONSLEG_*.fmx4.zip`, which `findDownloadUrls` already handles.

*Harness limitation:* the probe unzips and parses only the largest member (the
act body), so its annex counts understate zipped acts. Article, recital and
definition counts are unaffected; the serving path combines all members.

## 3. The two findings that should actually drive the decision

**Consolidated texts have no recitals. None, anywhere.** Every one of the 13
acts parsed to `0` recitals against 49–180 in the as-adopted text. This is not a
GDPR quirk; it is what EUR-Lex consolidation does. Rendering a consolidated
version therefore blanks the recital grid, the TF-IDF recital→article map, the
AI recital titles and the related-recitals rail — the features that most
distinguish this reader from EUR-Lex's own.

**For heavily amended acts, the consolidated text is a different act.**

| act | articles consolidated vs adopted | added | removed |
|---|---|---:|---:|
| GDPR | 99 vs 99 | 0 | 0 |
| Consumer Rights Directive | 36 vs 37 | 1 | 1 |
| PSD2 | 118 vs 117 | 1 | 0 |
| AI Act | 119 vs 113 | 6 | 0 |
| MiFID II | 103 vs 102 | 6 | 5 |
| Waste Framework Directive | 54 vs 45 | 11 | 0 |
| AML Directive 4 | 81 vs 69 | 12 | 0 |
| Solvency II | 334 vs 318 | 22 | 6 |
| CRD IV | 197 vs 165 | 32 | 0 |
| Emissions Trading Directive | 83 vs 33 | 50 | 0 |
| VAT Directive | 496 vs 414 | 82 | 0 |
| CRR | 786 vs 525 | 265 | 5 |

The "only changes a few things" intuition is correct for the GDPR and for young
acts, and badly wrong for the acts that motivate the feature. Running the probe
with `--articles 32013R0575` confirms the CRR delta is real, not parser noise:
**all 265 added articles are suffixed insertions** — `5a`, `10a`, `47a`, `47b`,
`47c`, `72a`…`72l`, `78a`. Half the operative text of the CRR that a
practitioner needs does not exist in what LegalViz renders today.

That cuts both ways. It is the strongest argument *for* the feature — and the
reason it cannot be modelled as "just another CELEX", because every index in the
app (search excerpts, citation graph, definitions, case-law `articleRefs`,
prerendered pages) is keyed to the as-adopted article numbering. A judgment
citing "Article 72b CRR" has nowhere to land today.

**Bonus finding: consolidated Formex rescues acts the current pipeline fails
on.** REACH renders as **0 articles, 0 recitals, 0 annexes** from the deployed
API right now (`source: eurlex-html` — the HTML fallback yields nothing). Its
consolidated Formex parses to 141 articles. For pre-Formex acts, consolidation
is not a "current text" feature at all — it is the only way to render them.

## 4. Recommendation

Build it, but not as a second law.

1. **Model a consolidation as another *expression* of the act.** Keep the
   sector-3 CELEX as identity for search, citation graph, definitions, case law,
   prerender and URLs; add a version dimension (`?version=2026-06-26`) that
   swaps article bodies. This is what keeps the recital loss survivable — serve
   the as-adopted recitals alongside consolidated articles, which is also the
   legally correct pairing, since consolidation does not amend recitals.
2. **Accept that article-level joins need a mapping.** Inserted articles
   (`72b`) have no as-adopted counterpart, so case-law and citation-graph links
   degrade rather than resolve. Decide deliberately whether an unmatched article
   shows nothing or falls back to the base act.
3. **Sequence pre-Formex acts first if you want the cheapest win.** For REACH
   and its cohort the choice is not "adopted vs consolidated", it is "nothing vs
   something", and none of the index-identity problems apply because there is no
   as-adopted parse to conflict with.
4. **Do not trust the version list to resolve.** ~1 in 14 is indexed but
   unservable; fall back to the as-adopted text rather than erroring.

Not recommended: rendering consolidated text under its own `0…` CELEX as the
issue proposes. It is the fastest route to a law page with no recitals, no case
law, no citation graph, and no way back.
