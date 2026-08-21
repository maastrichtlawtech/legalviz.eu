# Case-law corpus refresh

Case-law is harvested by
[`refresh-corpus.yml`](../../.github/workflows/refresh-corpus.yml), the
`Refresh corpus` workflow. Its output then flows through
[`refresh-data.yml`](../../.github/workflows/refresh-data.yml), `Refresh data`,
and [`refresh-fulltext.yml`](../../.github/workflows/refresh-fulltext.yml),
`Refresh fulltext`, through successful `workflow_run` triggers.

The [legislation data refresh runbook](legislation-data-refresh.md) documents
the complete corpus → data → full-text chain, immutable release tags, separate
Docker PRs, candidate inspection, failure recovery, flag traps, and accepted
stale citation/definitions limits.

## Schedule and dispatch

`Refresh corpus` runs monthly at 03:43 UTC on the fifth day of the month
(`43 3 5 * *`). Manual and scheduled runs publish the next immutable, dated
corpus release (`corpus-YYYY-MM-DD.NN`; see the
[release tag grammar](legislation-data-refresh.md#release-tag-grammar))
automatically after validation. The only human deploy gate is merging the
downstream Docker tag-bump PRs; no environment approval gate is involved.

GitHub's built-in workflow failure notifications are the only notifications
emitted by the workflow.

## Harvest sequence

1. Restore the latest published corpus release archives and harvest journals,
   plus the current `search-cache.json.gz` used for legislation gap comparison.
2. Run `search/cellar-gap-audit.js` for the current and previous years. Missing
   English primary acts are written one CELEX per line to `missing.txt`.
3. Backfill missing legislation into the raw `laws/` corpus. The corpus job
   uses `--no-eurovoc --no-in-force` to avoid unnecessary derived enrichment
   while acquiring files; `Refresh data` later performs full metadata
   enrichment for every corpus CELEX absent from the restored cache.
4. Install Chromium, run `search/case-law-discover.js`, then run
   `search/case-law-harvest.js --skipDiscover`.
5. Validate the harvest state: discovery must finish, the target list must be
   complete, and transient `failed` judgment diagnostics must be empty for
   release. Permanent `missing` judgments are allowed and recorded.
6. Package `laws.tar`, `laws-html.tar`, and `case-law.tar` plus harvest state,
   targets, misses, and optional metadata journals. Publish them as the next
   immutable dated corpus release; never replace a published corpus tag.

The downstream data workflow consumes the successful corpus release and updates
`case-law-cache.json.gz`, then the full-text workflow consumes the successful
data run. Case-law itself does not open a Docker PR; `Refresh data` opens its
own `automation/<tag>` PR for the data release and `Refresh fulltext` opens
`automation/<tag>` for the fulltext release when its act count grows.

## EUR-Lex WAF and harvest behavior

EUR-Lex may challenge GitHub-hosted runner IPs. The harvester warms a Chromium
session, carries the resulting cookies and user-agent into ordinary fetches,
and retries session warming when a challenge recurs. A successful browser
installation does not prove that the runner IP was accepted.

The corpus job validates saved, skipped, missing, and failed counts and rejects
a candidate with a nonzero transient `failed` count or regressing corpus file
count. Permanent `missing` judgments remain recorded in the corpus diagnostics
and may be retried by a later manual run; they do not by themselves block
publication.

`Refresh data` finds corpus CELEX IDs absent from the restored search cache,
backfills them with full metadata enrichment, and then runs
`search/case-law-parse.js`. Case-law parsing therefore belongs to the data
stage, not this corpus harvest stage.

## Failure and recovery

A failed corpus run does not trigger `Refresh data` or `Refresh fulltext`, does
not publish a release, and does not change production. Re-run the corpus
workflow from the latest immutable release after fixing WAF, network, or harvest
issues. Case-law parser failures belong to the data stage. If a draft next-tag
release exists, the workflow verifies and resumes that draft; a published tag
is never overwritten.

After a successful corpus run, inspect the downstream data and full-text
artifacts and their manifests. For count, SQLite integrity, WAL cleanup, PR
recovery, rollback, and stale derived-asset behavior, use the
[failure and recovery table](legislation-data-refresh.md#failure-behavior-and-recovery)
in the main runbook.
