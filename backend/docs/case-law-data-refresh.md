# Case-law data refresh runbook

This runbook explains how the `Refresh case-law data` GitHub Actions workflow
collects, validates, publishes, and deploys case-law data. It is intended for
repository maintainers operating the data release process.

The workflow is defined in
[`refresh-case-law-data.yml`](../../.github/workflows/refresh-case-law-data.yml).

## Schedule and operating modes

The automatic refresh runs on the third day of every month at 02:17 UTC
(`17 2 3 * *`). That is normally 03:17 CET or 04:17 CEST in the Netherlands.
GitHub may delay scheduled jobs during periods of high Actions load.

The workflow has three modes:

| Invocation | `publish` input | Result |
| --- | --- | --- |
| Monthly schedule | Not applicable | Builds and uploads a candidate; never publishes or deploys it |
| Manual validation | `false` | Builds and uploads a candidate; never publishes or deploys it |
| Manual publication | `true`, with a new `data-vN` tag | Builds a candidate, waits at the publication gate, creates a release, and opens a deployment PR |

Scheduled and manual triggers only work after the workflow exists on the
repository's default branch.

## What a refresh does

The workflow performs these steps in order:

1. Read the current `DATA_RELEASE_TAG` from `backend/Dockerfile`.
2. Download that release's `search-cache.json.gz` and
   `case-law-cache-v5.json.gz` assets.
3. Restore the raw compressed judgment HTML corpus from the GitHub Actions
   cache, when available.
4. Query CELLAR's SPARQL endpoint for the complete set of CJEU and General Court
   judgments that formally interpret legislation.
5. Walk the target list and download judgment HTML that is absent from the raw
   corpus.
6. Parse new judgments, plus judgments whose stored citation-parser version is
   stale, into the case-law JSON cache.
7. Rebuild the complete standalone SQLite database and its integrity manifest.
8. Compare JSON and SQLite search behavior against the committed ranking
   contract.
9. Save the updated raw corpus in the Actions cache and upload the candidate
   release files as a workflow artifact retained for 14 days.

The legislation search cache is carried forward unchanged. This workflow
refreshes case law; it does not discover or rebuild the legislation search
corpus.

## What is incremental

The expensive network and parsing work is normally incremental, but the entire
pipeline is not.

| Stage | Incremental behavior |
| --- | --- |
| Judgment discovery | Queries the complete target set each run; this is only a small number of paginated SPARQL requests |
| Raw HTML harvest | Scans every target but skips judgments already present as compressed corpus files |
| Judgment parsing | Skips entries already parsed with the current citation-parser version |
| SQLite build | Rebuilds the complete database rather than patching the previous artifact |
| Ranking validation | Loads both complete backends and runs the committed query contract |

A warm-cache monthly run should therefore make only a few discovery requests,
perform inexpensive file-existence checks for the existing corpus, download and
parse new judgments, and then rebuild and validate the complete artifact.

If the Actions cache is cold or has been evicted, the workflow must re-download
the raw judgment corpus. If the citation-parser version changes, it reparses the
raw corpus without downloading it again.

The harvest deliberately scans from the start rather than persisting an index
cursor. Newly discovered CELEX identifiers can sort anywhere in the target list,
so resuming at an old numeric position could skip new judgments.

## Chromium and EUR-Lex WAF handling

EUR-Lex protects its HTML endpoint with a web application firewall. The
workflow installs headless Chromium through Playwright for session warming, not
for rendering every judgment.

For a network fetch, the harvester:

1. Opens the EUR-Lex homepage once in headless Chromium.
2. Captures the resulting cookies and browser user-agent.
3. Closes Chromium.
4. Downloads judgment HTML sequentially with ordinary `fetch` requests carrying
   those headers.
5. Invalidates and re-warms the session if EUR-Lex returns another WAF
   challenge.

This keeps browser use bounded, but access from GitHub-hosted runner IP
addresses remains an external dependency. A successful browser installation
does not prove that EUR-Lex accepted the session.

## Reviewing a scheduled candidate

Open **Actions > Refresh case-law data**, select the run, and download the
`case-law-data-<run-id>` artifact. It contains:

| File | Review purpose |
| --- | --- |
| `case-law-cache-v5.json.gz` | Updated structured judgment cache |
| `search-cache.json.gz` | Legislation search input carried from the current release |
| `data.sqlite` | Candidate runtime database |
| `data.sqlite.manifest.json` | Input and artifact hashes, schema version, row counts, and integrity results |
| `search-parity-report.json` | Per-query JSON/SQLite rankings and the parity summary |

Before publication, verify at minimum:

- the refresh and parity steps completed successfully;
- the manifest reports `integrity.sqlite` as `ok` and zero orphan mappings;
- case-law counts did not unexpectedly decrease;
- the parity report has zero failures and only documented top-result changes;
- the harvest log shows plausible saved, skipped, missing, and failed counts;
- a sample of newly added judgments resolves to sensible names, declarations,
  and article references.

## Configure the publication approval gate

The workflow references a GitHub environment named `data-release`. Repository
administrators must configure it; naming an environment in YAML is not by
itself a meaningful approval policy.

In **Settings > Environments > data-release**:

1. Add the maintainers who may approve publication as required reviewers.
2. Prevent self-review if independent approval is required.
3. Restrict deployment branches to the default or protected branch as
   appropriate for the repository.

The publication job receives write permissions only after the refresh job has
completed and the environment gate has been approved.

## Publishing and deploying a release

To publish:

1. Open **Actions > Refresh case-law data > Run workflow**.
2. Select the `main` branch.
3. Set `publish` to `true`.
4. Enter a new tag matching `data-vN`, for example `data-v7`. Existing tags are
   rejected.
5. Start the workflow and inspect the completed refresh job.
6. When the `publish` job waits for the `data-release` environment, use
   **Review deployments** to approve or reject it.

After approval, the workflow creates an immutable GitHub release and opens an
`automation/data-vN` pull request that changes `DATA_RELEASE_TAG` in the backend
Dockerfile. Review and merge that pull request to deploy the release. The
environment approval authorizes publication; the tag-bump pull request is a
separate deployment approval.

Rollback is performed by opening a pull request that restores
`DATA_RELEASE_TAG` to a previously validated release. Published data tags should
not be moved or overwritten.

## Current limitations and first-run validation

The refresh workflow has not been proven merely because the separate backend
Docker workflow passes. Before relying on the schedule, complete a capped or
otherwise controlled GitHub-hosted smoke harvest and confirm that EUR-Lex
accepts the warmed session from a runner IP.

The current implementation also has these limitations:

- Individual harvest failures are counted and logged but do not by themselves
  fail the workflow. A run can therefore remain green while downloading no new
  judgments.
- The permanent-miss and transient-failure sidecars are not retained in the
  Actions cache, so unavailable judgments may be retried on later runs.
- A scheduled artifact cannot currently be promoted directly. Publication is a
  new manual refresh, so it may not be byte-for-byte identical to the earlier
  scheduled candidate.
- A cold corpus cache can turn the normal incremental update into a complete
  re-harvest.
- The GitHub-hosted refresh job is limited to the configured 330 minutes and
  ultimately to GitHub's hosted-runner job limit.

Before declaring the automation operational, add or perform a GitHub-hosted
smoke run and confirm all of the following:

1. Chromium installs and launches.
2. Cookie warming produces an accepted EUR-Lex session.
3. At least one uncached judgment downloads and is written to the corpus.
4. The parser adds that judgment to the structured cache.
5. SQLite construction and ranking parity pass.
6. The resulting artifact can be downloaded and inspected.

## Failure recovery

| Symptom | Response |
| --- | --- |
| Repeated WAF challenges | Retry once to rule out a transient block; inspect Chromium and harvest logs; use a permitted self-hosted runner if GitHub runner IPs are consistently rejected |
| Cold or evicted corpus cache | Allow a full harvest within the time limit, or seed the cache from a trusted corpus artifact |
| Parser failures | Fix the parser and rerun; already downloaded raw HTML does not need to be fetched again |
| Parity failure | Inspect `search-parity-report.json`; document and approve an intentional ranking change or fix the regression before publication |
| Manifest/count regression | Do not publish; compare the current release inputs, discovery count, harvest log, and parser output |
| Publication rejected | The candidate remains an Actions artifact until retention expiry; no release or deployment PR is created |
| Release published but deployment rejected | Leave the immutable release in place and close the Docker tag-bump PR; production remains on the previous tag |
