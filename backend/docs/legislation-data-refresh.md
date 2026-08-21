# Automated legislation data refresh

Legislation and full-text refresh are a three-workflow success chain. The
workflows and their exact triggers are:

| Stage | Workflow | Trigger | Published output |
| --- | --- | --- | --- |
| Corpus | [`refresh-corpus.yml`](../../.github/workflows/refresh-corpus.yml) — `Refresh corpus` | Monthly schedule `43 3 5 * *`, or manual dispatch | Immutable dated `corpus-YYYY-MM-DD.NN` release and raw-corpus candidate artifact |
| Data | [`refresh-data.yml`](../../.github/workflows/refresh-data.yml) — `Refresh data` | Successful `workflow_run` of `Refresh corpus`, or manual dispatch | Immutable dated `data-YYYY-MM-DD.NN` release and matching `automation/<tag>` Docker PR |
| Full text | [`refresh-fulltext.yml`](../../.github/workflows/refresh-fulltext.yml) — `Refresh fulltext` | Successful `workflow_run` of `Refresh data`, or manual dispatch | Immutable dated `fulltext-YYYY-MM-DD.NN` release and matching `automation/<tag>` Docker PR |

## Release tag grammar

Every tag these workflows mint is dated: `<train>-YYYY-MM-DD.NN`, e.g.
`corpus-2026-08-21.01` — the UTC day of the release plus a zero-padded
same-day sequence starting at `01`. The older `<train>-vN` grammar (still seen
in the `backend/Dockerfile` pins and older release history) is still accepted
wherever an existing tag is read, but is never minted again. The change exists
because the old counter was derived by reading the current `DATA_RELEASE_TAG`/
`FULLTEXT_RELEASE_TAG` pin and adding one: a second run starting before the
tag-bump PR from the first had merged recomputed that same next tag, found it
already published, and refused to publish its fresher data.
[`.github/scripts/release-tags.sh`](../../.github/scripts/release-tags.sh) is
the single source of this grammar — its `validate`, `latest`, and `resolve`
subcommands are what the workflows below call to check, look up, and mint tags.

The normal monthly chain is therefore:

```text
Refresh corpus (corpus-YYYY-MM-DD.NN)
        -> successful workflow_run
Refresh data (data-YYYY-MM-DD.NN + DATA_RELEASE_TAG PR)
        -> successful workflow_run
Refresh fulltext (fulltext-YYYY-MM-DD.NN + FULLTEXT_RELEASE_TAG PR)
```

Scheduled runs publish each validated immutable release automatically. The
only human deploy gate is merging the generated Docker tag-bump PRs; there is
no environment approval gate. The data and full-text releases
and PRs are separate, so a full-text update never requires rebuilding the data
release and a data-only update need not advance full text.

## Manual dispatch and no-op behavior

All three workflows expose `workflow_dispatch`. Manual corpus and data runs
publish automatically after validation, matching the scheduled chain; this
ensures a successful upstream run never triggers its downstream workflow
against an older release. `Refresh fulltext`, which has no downstream stage,
also exposes `publish: false` for candidate-only inspection. With `release_tag`
omitted, the stage resolves today's next free tag, so the automatic path can
never collide with an existing release. Passing `release_tag` explicitly
(`Refresh corpus` and `Refresh fulltext` only) validates it against the grammar
above and uses it verbatim; that is the one way to name a tag that is already
published, and it is the deliberate recovery path in the table below.

The downstream workflows run from a successful upstream `workflow_run`. If a
stage finds no change, it finishes successfully with a summary and does not
publish a new release or open a PR for that stage. A no-op full-text stage may
still upload its validation artifact, but it does not advance the fulltext
release.

GitHub's built-in workflow failure notifications are the only notifications
provided. Configure repository or organization Actions notifications for email
or inbox alerts; the workflows do not send Slack, Teams, or custom email.

## Stage 1: corpus refresh

`Refresh corpus` restores the latest immutable corpus release and current
search cache, then updates all raw inputs used by later stages:

1. Restore `laws.tar`, `laws-html.tar`, `case-law.tar`, the case-law harvest
   state/targets/miss files, and optional metadata journals (`law-dates.json`,
   `eurovoc.json`, and `in-force.json`).
2. Remove the stub `search/data/search-cache.json` so readers use the released
   `search-cache.json.gz`.
3. Run `search/cellar-gap-audit.js` for the current and previous years. It
   reuses the English-language and primary-act filters from `search-build.js`
   and writes one missing CELEX per line to `missing.txt`.
4. Backfill missing acts to acquire their raw `laws/` files. The corpus
   workflow uses `--no-eurovoc --no-in-force` to avoid unnecessary derived
   enrichment at this stage; any interim cache entries are not the final
   metadata. The data workflow performs full metadata enrichment after it
   restores the corpus.
5. Discover and harvest case-law targets with Chromium session warming, then
   validate the harvest state. Case-law parsing is deferred to `Refresh data`.
   A successful corpus candidate requires complete targets, zero transient
   `failed` judgments, and non-regressing `laws`, `laws-html`, and `case-law`
   file counts. Permanent `missing` judgments are allowed and recorded.
6. Package the three tar archives and diagnostics. Publication creates a new
   dated corpus release; the resolve step never mints a tag that is already
   published, so a rerun after a fully successful run builds and publishes a
   fresh release rather than colliding with it.

The corpus release is the durable input for both derived stages. Its required
assets include the three tar files and case-law harvest diagnostics; journals
are included when present. See the [case-law runbook](case-law-data-refresh.md)
for WAF, harvest, and parser recovery details.

## Stage 2: data refresh

`Refresh data` starts only after a successful `Refresh corpus` workflow run. It
restores the latest immutable corpus and current data release assets, then:

1. Finds every corpus CELEX in `laws/` or `laws-html/` that is absent from the
   restored search cache and writes those IDs to `corpus-missing.txt`.
2. Runs `backfill-cache.js` for `@corpus-missing.txt` without the corpus-stage
   opt-out flags, thereby applying full date, EuroVoc, in-force, title,
   excerpt, and derived search enrichment.
3. Parses the restored case-law corpus with `search/case-law-parse.js`, adding
   new judgments and reparsing entries whose parser version is stale.
4. Packages the updated `search-cache.json.gz` and `case-law-cache.json.gz`,
   and carries `citation-graph.json.gz` and optional `definitions.json.gz`
   forward unchanged.
5. Runs the SQLite conversion and validation with
   `search/build-sqlite-data.js`. The manifest must report
   `integrity.sqlite == "ok"`, zero orphan law/FTS mappings, and record counts
   matching both source caches.
6. Uploads `derived-data-<run-id>` for 14-day inspection, including
   `refresh-summary.json`, manifests, logs, and the complete data candidate.
7. Publishes the next immutable dated data release only after candidate
   validation, then opens `automation/<tag>` for that release tag. That PR
   changes only `ARG DATA_RELEASE_TAG` in `backend/Dockerfile` and dispatches
   the backend Docker smoke/evaluation workflow for the exact branch.

The data workflow carries case-law and legislation caches together in the data
release. It does not rebuild the full-text SQLite file; that is the next
`workflow_run` stage.

## Stage 3: full-text refresh

`Refresh fulltext` starts only after a successful `Refresh data` run. It restores
the latest data release, fulltext release, and corpus `laws`/`laws-html`
assets, then:

1. Validate the current full-text manifest against the decompressed SQLite
   database and record the baseline `actCount`.
2. Run `search/fulltext-index-build.js` with the updated search cache and the
   restored corpus. Its `doneCelex` resume logic appends only acts not already
   indexed.
3. Checkpoint SQLite's WAL with `wal_checkpoint(TRUNCATE)`, delete
   `fulltext.sqlite-wal` and `fulltext.sqlite-shm`, recompute the manifest hash,
   and gzip the main database.
4. Require a non-regressing `actCount` and matching manifest counts/hashes.
   Report any full-text parse failures in the validation artifact; they are
   not an independent publication blocker. Upload
   `fulltext-data-<run-id>` for 14-day inspection.
5. When `actCount` grows, publish the next immutable dated fulltext release and
   open `automation/<tag>` for that release tag. That PR changes only
   `ARG FULLTEXT_RELEASE_TAG`; merging it is the deploy gate.

## Candidate inspection

Inspect the stage artifact and generated PR checks. For a full-text
`publish: false` dispatch, inspect its candidate before rerunning with
publication enabled. At minimum verify:

- corpus tar roots and non-regressing `laws`, `laws-html`, and `case-law` counts;
- case-law harvest state is finished with zero transient `failed` entries;
  permanent `missing` judgments may be non-empty but must be recorded;
- `refresh-summary.json` and data SQLite manifest record counts agree with the
  source caches;
- data manifest integrity is `ok` with zero orphan mappings;
- full-text manifest `actCount`, unit counts, bytes, and SHA-256 match the
  checkpointed SQLite artifact; parse failures are reported for review but do
  not independently block publication; and
- carried-forward citation graph and definitions hashes are unchanged unless a
  separate intentional rebuild was performed.

Do not publish a candidate that fails its workflow validation, is incomplete,
count-regressing, or WAL-bearing. Full-text parse failures alone do not fail
publication when the manifest is valid, `actCount` is non-regressing, and the
candidate actually grows `actCount`.
The scheduled chain performs these validations before each automatic release.

## Failure behavior and recovery

Each downstream workflow runs only when its triggering `workflow_run` concludes
successfully. A failure stops that stage and prevents its release and Docker PR;
the previous release tags remain production inputs. A failed run may leave a
14-day diagnostic artifact, but it never turns a partial candidate into a
published immutable release.

| Failure | Recovery |
| --- | --- |
| Corpus download, Cellar audit, or backfill fails | Inspect logs and `missing.txt`, then rerun `Refresh corpus` manually from the latest published corpus release. Do not edit a published corpus tag. |
| Backfill is partial | Rerun with the recorded CELEX list; `backfill-cache.js` skips IDs already present. Recheck the cache count and metadata before allowing downstream workflows to run. |
| EUR-Lex WAF or case-law harvest failure | Retry the corpus workflow after checking Chromium/session logs. Existing raw files are corpus skips; transient `failed` entries must reach zero, while permanent `missing` entries are allowed and recorded. |
| Data manifest/count validation fails | Do not publish the data release. Compare source cache counts, SQLite manifest integrity, carried-forward hashes, and the upstream corpus release; retry `Refresh data` after correction. |
| Full-text build fails or leaves a WAL | Reopen the database, run `wal_checkpoint(TRUNCATE)`, remove both `-wal` and `-shm`, and rerun `Refresh fulltext`. Never gzip or publish sidecars. Parse failures reported by a successful build are reviewed but do not independently fail publication. |
| A run was interrupted while its release was still a draft | Rerun the same stage. `resolve` returns that draft (`state=draft`), so the rerun finishes the same tag and recovers/updates the matching `automation/<tag>` branch rather than overwriting release contents. |
| A run is rerun after its release was already published (PR interrupted, or simply retried) | The automatic path never resolves a published tag, so the rerun builds and publishes a *new* dated release instead of reopening the old PR — rerunning a fully successful stage is not free. To act on the existing release instead, pass its tag to the `release_tag` workflow_dispatch input (`Refresh corpus` and `Refresh fulltext` only), which re-verifies the published release and updates its PR. `Refresh data` has no such input: open its one-line `DATA_RELEASE_TAG` PR by hand. Without an explicit tag, a resolved-but-published tag is treated as a resolver bug and fails loudly. |
| A Docker PR is not merged | Production remains on the prior Docker tag. Review or close the PR; release assets remain immutable and auditable. |
| A deployed release is bad | Open a corrective PR restoring only the affected `DATA_RELEASE_TAG` and/or `FULLTEXT_RELEASE_TAG` to the last validated pair. |

## Flag traps

- The corpus backfill command uses `--no-eurovoc` (and `--no-in-force`) while
  acquiring raw files to avoid unnecessary derived enrichment. The data-stage
  backfill then performs full metadata enrichment. Do not translate
  `--no-eurovoc` to `--eurovoc false`; the `search-build.js` programmatic/other
  CLI path expresses that option as `eurovoc: false` instead.
- Full-text cache selection is through
  `SEARCH_CACHE_PATH=<path-to-search-cache.json.gz>`; there is no full-text
  builder CLI flag for the search-cache path.
- A WAL-backed SQLite database is incomplete until checkpointed. Delete both
  `-wal` and `-shm` before gzip and before hashing the release artifact.

## Accepted v1 limitations

- `citation-graph.json.gz` and `definitions.json.gz` are carried forward by
  `Refresh data`, so they can be stale for brand-new acts until a separate
  manual/rare rebuild.
- The citation graph has no safe incremental path in v1; a full in-memory
  rebuild is outside the monthly chain and may be incomplete under a small
  worker heap.
- Already harvested CELEX text is not re-fetched. A new amending/adopted CELEX
  is added, but changed upstream text for an existing CELEX waits for a rebuild
  or explicit repair.
- Each runner has a 330-minute ceiling. The incremental/full-text stages should
  be minutes scale, but a cold corpus restore, Chromium setup, or upstream
  outage can make a run materially longer.
