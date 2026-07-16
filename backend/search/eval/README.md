# Search evaluation

This directory keeps search-quality cases and measurement code in Git so a
search-engine change can be evaluated against the same inputs before it is
merged.

Run the small committed fixture:

```bash
npm run eval:search
```

The 21 cases in `queries.json` are a smoke/regression suite. The broader
ranking evaluation is `ranking-queries.json`: 100 curated cases split into 80
development cases and 20 holdout cases. It requires the production data store
because most of those laws are intentionally absent from the small fixture:

```bash
node --expose-gc search/eval/run.js \
  --sqlite search/data/data.sqlite \
  --cases search/eval/ranking-queries.json \
  --split development \
  --limit 10 \
  --iterations 10
```

Use the development split while changing ranking constants. Run the holdout
split only to validate a chosen configuration; do not tune against it. Omit
`--split` to report both.

Run the small, predefined rank-fusion ablation grid against development only:

```bash
node search/eval/tune-ranking.js --sqlite search/data/data.sqlite
```

Add `--ablations-only` to run only the selected configuration and the
single-signal removal checks.

The tuning script cannot load holdout cases. Its objective combines nDCG@10,
recall@1, recall@5, and pairwise accuracy; use it to select a candidate, then
confirm that candidate once on holdout with `run.js`.

For the final candidate, calculate a deterministic paired-bootstrap confidence
interval against baseline (holdout is the default split):

```bash
node search/eval/compare-ranking.js \
  --sqlite search/data/data.sqlite \
  --enable-rewrites \
  --samples 10000
```

## Data-v9 benchmark (2026-07-16)

The selected reciprocal-rank fusion uses independent title/alias, EuroVoc, and
excerpt candidate sources, followed by the act-type, in-force-status, and
log-damped citation priors. Against the 80/20 split above (`limit=10`):

| Split | Ranking | Recall@1 | Recall@5 | nDCG@10 |
| --- | --- | ---: | ---: | ---: |
| Development | baseline | 65.0% | 77.5% | 0.655 |
| Development | selected | 75.0% | 90.0% | 0.808 |
| Holdout | baseline | 35.0% | 65.0% | 0.520 |
| Holdout | selected | 60.0% | 80.0% | 0.759 |

Development-only removal ablations support retaining every revised signal:

| Configuration | Recall@1 | Recall@5 | nDCG@10 |
| --- | ---: | ---: | ---: |
| selected | 75.0% | 90.0% | 0.808 |
| without citation prior | 72.5% | 88.8% | 0.786 |
| without EuroVoc source | 72.5% | 88.8% | 0.778 |
| without status prior | 70.0% | 88.8% | 0.782 |
| without excerpt source | 58.8% | 75.0% | 0.660 |
| title/alias source only | 57.5% | 70.0% | 0.606 |

Selected candidate recall was 100% on development and 95% on holdout. In the
same 800-query development benchmark, p95 latency was 139.9 ms versus 135.0 ms
for baseline; heap after load was 384.7 MB versus 330.0 MB. Treat timings as
machine-specific and rerun them when the data asset or runtime changes.

The table was measured with rewrites disabled to isolate ranking. The final
deployment gate repeats holdout with rewrites enabled, matching `/api/search`.

Data-v9 signal coverage was 84.6% for EuroVoc, 87.0% for known in-force status,
99.6% for excerpts, and 43.1% for at least one incoming legislative citation.
`run.js` reports these percentages on every run so data-pipeline regressions are
visible alongside ranking quality.

Add `--baseline-ranking` to disable EuroVoc retrieval and the citation/status
priors while retaining the same cache, queries, limits, and runtime. This makes
before/after comparisons reproducible without checking out another commit.

Run against a production-format cache with less noisy memory measurements:

```bash
node --expose-gc search/eval/run.js \
  --cache search/data/search-cache.json \
  --iterations 10
```

Pass the raw `.json` path; when it is absent, the store uses its usual
`.json.gz` sibling fallback. Add `--json` for machine-readable output and
`--enable-rewrites` to include query rewrites.
Latency and memory numbers are informational: compare engines on the same
machine, Node version, cache, query set, warm-up, and iteration count. Quality
metrics are deterministic and are asserted by the search regression test.

Use `--label minisearch`, `--label fts5`, or another descriptive name when
saving JSON reports. To compare implementations, run the same command on each
branch with an identical cache and arguments; reports include Node, platform,
and architecture metadata to help spot invalid comparisons.

## Dataset policy

`queries.json` is versioned and categorized. A schema-v1 case may list multiple
acceptable CELEX identifiers when the query genuinely has more than one valid
answer. Schema v2 adds graded judgments (`1` contextual, `2` strongly relevant,
`3` primary answer), explicit `mustOutrank` pairs, and development/holdout
splits. The harness reports nDCG@5/10 and pairwise accuracy in addition to the
navigational recall/MRR metrics. Add cases from observed failures, but do not
tune expected results to whichever engine happens to rank first or generate
relevance labels from the same EuroVoc/citation signals being evaluated.

The committed fixture makes the harness runnable in CI and a fresh checkout.
The full production cache remains a GitHub Release asset because it is too
large for Git. This seed set is a regression suite, not a representative user
sample; expand it before using aggregate recall to justify an engine migration.

## Historical MiniSearch result

Commit `63a3ef0` introduced the deterministic-exact + MiniSearch hybrid. Its
commit message records an MVP evaluation against the production cache:

- recall@1 improved from 63% to 76%+
- typo recall@1 improved from 13% to 75%
- p50 latency was approximately 1 ms
- exact identifier and known-alias lookups did not regress

The larger query set and original benchmark script were not committed, so
those figures cannot be reproduced exactly. The first 15 entries in
`queries.json` preserve the regression queries that did land with that change.
Treat the historical figures as provenance, not a current baseline.
