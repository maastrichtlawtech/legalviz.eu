#!/usr/bin/env node
// Renders the human-readable summary that the refresh workflows attach to the
// release they publish and to the Dockerfile tag-bump PR they open.
//
// The PR itself is a one-line tag change, so the diff tells a reviewer nothing
// about what is actually being deployed. Everything below is read back from the
// artifacts the run already validated — no counting happens here, so the summary
// cannot disagree with the checks that gated the release.
//
// Usage:
//   render-refresh-notes.mjs --kind corpus|data|fulltext --dir <assets> \
//     --tag <release-tag> --run-url <url> [--mode pr|release] [--corpus-tag <tag>]

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const options = { mode: "release" };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  options[key] = args[i + 1];
}
for (const required of ["kind", "dir", "tag", "runUrl"]) {
  if (!options[required]) throw new Error(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : "—");
const delta = (before, after) => {
  const diff = Number(after) - Number(before);
  if (!Number.isFinite(diff)) return "—";
  return diff === 0 ? "±0" : `${diff > 0 ? "+" : "−"}${Math.abs(diff).toLocaleString("en-US")}`;
};

function bytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024).toFixed(0)} KiB`;
}

function readJson(file) {
  const full = path.join(options.dir, file);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    // Every caller has a fallback rendering: a summary is worth degrading, never
    // worth failing a publish over.
    return null;
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(path.join(options.dir, file), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Returns "" rather than a bare heading when none of the named assets exist,
// so a degraded input drops the section instead of showing an empty one.
function assetSection(names) {
  const rows = names
    .map((name) => [name, fs.existsSync(path.join(options.dir, name)) ? fs.statSync(path.join(options.dir, name)).size : null])
    .filter(([, size]) => size !== null)
    .map(([name, size]) => `| \`${name}\` | ${bytes(size)} |`);
  return rows.length ? ["### Assets", "", "| asset | size |", "| --- | ---: |", ...rows].join("\n") : "";
}

// A full list would bury the rest of the summary, and a reviewer spot-checking
// ids does not need all of them; the count above the fold stays exact.
function celexSample(ids, label, limit = 100) {
  if (!ids.length) return "";
  const shown = ids.slice(0, limit);
  const tail = ids.length > shown.length ? `\n\n…and ${num(ids.length - shown.length)} more.` : "";
  return `<details>\n<summary>${label}</summary>\n\n${shown.map((id) => `\`${id}\``).join(", ")}${tail}\n</details>`;
}

const sections = [];

if (options.kind === "corpus") {
  const summary = readJson("corpus-summary.json") || {};
  const files = summary.files || {};
  const before = summary.baselineFiles || {};
  sections.push(
    "### Corpus files",
    [
      "| source | before | after | change |",
      "| --- | ---: | ---: | ---: |",
      `| Legislation (Formex) | ${num(before.laws)} | ${num(files.laws)} | ${delta(before.laws, files.laws)} |`,
      `| Legislation (HTML fallback) | ${num(before.lawsHtml)} | ${num(files.lawsHtml)} | ${delta(before.lawsHtml, files.lawsHtml)} |`,
      `| Case law | ${num(before.caseLaw)} | ${num(files.caseLaw)} | ${delta(before.caseLaw, files.caseLaw)} |`,
    ].join("\n"),
  );
  if (summary.legislationMissing !== undefined) {
    sections.push(`The gap audit found **${num(summary.legislationMissing)}** CELEX ids in Cellar that the search cache did not have; those are what this refresh fetched.`);
  }
  sections.push(assetSection(["laws.tar", "laws-html.tar", "case-law.tar"]));
  sections.push(celexSample(readLines("missing.txt"), "CELEX ids the gap audit asked for"));
}

if (options.kind === "data") {
  const summary = readJson("refresh-summary.json") || {};
  const manifest = readJson("data.sqlite.manifest.json") || {};
  const search = summary.search || {};
  const caseLaw = summary.caseLaw || {};
  sections.push(
    "### Records",
    [
      "| cache | before | after | change |",
      "| --- | ---: | ---: | ---: |",
      `| Search cache (acts) | ${num(search.baselineRecords)} | ${num(search.candidateRecords)} | ${delta(search.baselineRecords, search.candidateRecords)} |`,
      `| Case law (judgments) | ${num(caseLaw.baselineRecords)} | ${num(caseLaw.candidateRecords)} | ${delta(caseLaw.baselineRecords, caseLaw.candidateRecords)} |`,
    ].join("\n"),
  );
  const tables = manifest.tables || {};
  if (Object.keys(tables).length) {
    sections.push(
      "### Rows in the shipped `data.sqlite`",
      [
        "| table | rows |",
        "| --- | ---: |",
        `| laws | ${num(tables.laws)} |`,
        `| excerpts | ${num(tables.excerpts)} |`,
        `| case law | ${num(tables.caseLaw)} |`,
        `| citations | ${num(tables.citations)} |`,
        `| definition terms | ${num(tables.definitionTerms)} |`,
        `| definition occurrences | ${num(tables.definitionOccurrences)} |`,
      ].join("\n"),
      `Integrity: SQLite \`${manifest.integrity?.sqlite ?? "—"}\`, ${num(manifest.integrity?.orphanLawMappings)} orphan law mappings, ${num(manifest.integrity?.orphanFtsMappings)} orphan FTS mappings.`,
    );
  }
  sections.push(assetSection(["search-cache.json.gz", "case-law-cache.json.gz", "citation-graph.json.gz", "definitions.json.gz", "data.sqlite.gz"]));
  // What the backfill actually added, not what it was asked to try. These
  // differ: the scan that builds corpus-missing.txt derives ids from corpus
  // filenames, and anything Cellar has no primary ELI for is dropped rather
  // than added. Reading the request list here once reported "80,465 acts
  // backfilled" on a release whose record count moved by zero.
  const backfill = readJson("backfill-result.json");
  if (backfill) {
    const addedIds = Array.isArray(backfill.addedIds) ? backfill.addedIds : [];
    sections.push(celexSample(addedIds, `${num(addedIds.length)} acts added to the search cache`));
    const requested = readLines("corpus-missing.txt").length;
    const dropped = Array.isArray(backfill.dropped) ? backfill.dropped.length : 0;
    if (dropped) {
      const wereDropped = dropped === 1 ? "was dropped" : "were dropped";
      sections.push(`The corpus scan asked for **${num(requested)}** ids; **${num(dropped)}** ${wereDropped} (no primary ELI in Cellar, or not a queryable CELEX id).`);
    }
  }
}

if (options.kind === "fulltext") {
  const validation = readJson("fulltext-validation.json") || {};
  const manifest = validation.manifest || {};
  sections.push(
    "### Indexed acts",
    [
      "| | before | after | change |",
      "| --- | ---: | ---: | ---: |",
      `| Acts | ${num(validation.baselineActCount)} | ${num(validation.candidateActCount)} | ${delta(validation.baselineActCount, validation.candidateActCount)} |`,
    ].join("\n"),
    [
      "| unit | rows |",
      "| --- | ---: |",
      `| all searchable units | ${num(manifest.unitCount)} |`,
      `| articles | ${num(manifest.articleCount)} |`,
      `| recitals | ${num(manifest.recitalCount)} |`,
    ].join("\n"),
    `Parse failures in this build: **${num(validation.failures)}**.`,
    assetSection(["fulltext.sqlite.gz"]),
  );
}

const lead = {
  corpus: `Validated raw legislation and case-law corpus published as \`${options.tag}\`.`,
  data: `Derived data published as \`${options.tag}\`${options.corpusTag ? `, built from corpus \`${options.corpusTag}\`` : ""}.`,
  fulltext: `Incremental full-text index published as \`${options.tag}\`.`,
}[options.kind];

const prLead = {
  corpus: "",
  data: `Updates only \`DATA_RELEASE_TAG\` in \`backend/Dockerfile\` to the validated immutable \`${options.tag}\` release${options.corpusTag ? `, built from corpus \`${options.corpusTag}\`` : ""}. Merge this PR to deploy it.`,
  fulltext: `Updates only \`FULLTEXT_RELEASE_TAG\` in \`backend/Dockerfile\` to the validated \`${options.tag}\` release. Merge this PR to deploy the immutable full-text asset.`,
}[options.kind];

const body = [
  options.mode === "pr" ? prLead : lead,
  ...sections.filter(Boolean),
  `Produced by [workflow run](${options.runUrl}). All counts are read back from the artifacts the run validated.`,
].filter(Boolean).join("\n\n");

process.stdout.write(`${body}\n`);
