# Search evaluation

This directory keeps search-quality cases and measurement code in Git so a
search-engine change can be evaluated against the same inputs before it is
merged.

Run the small committed fixture:

```bash
npm run eval:search
```

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

`queries.json` is versioned and categorized. A case may list multiple
acceptable CELEX identifiers when the query genuinely has more than one valid
answer. Add cases from observed failures, but do not tune expected results to
whichever engine happens to rank first.

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
