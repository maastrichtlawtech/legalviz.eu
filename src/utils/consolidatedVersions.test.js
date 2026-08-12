import { describe, it, expect } from "vitest";

import {
  selectConsolidatedVersions,
  summarizeAmendments,
  todayIso,
} from "./consolidatedVersions.js";

const VERSIONS = [
  { celex: "02013R0575-20260626", date: "2026-06-26" },
  { celex: "02013R0575-20130628", date: "2013-06-28" },
  { celex: "02013R0575-20270101", date: "2027-01-01" },
];

describe("selectConsolidatedVersions", () => {
  it("picks the newest version already in force and lists the rest as upcoming", () => {
    const { current, upcoming, all } = selectConsolidatedVersions(VERSIONS, "2026-08-12");

    expect(current.celex).toBe("02013R0575-20260626");
    expect(upcoming.map((v) => v.date)).toEqual(["2027-01-01"]);
    expect(all.map((v) => v.date)).toEqual(["2013-06-28", "2026-06-26", "2027-01-01"]);
  });

  it("treats a version dated today as in force", () => {
    expect(selectConsolidatedVersions(VERSIONS, "2026-06-26").current.date).toBe("2026-06-26");
  });

  it("reports no current version when every consolidation is still ahead", () => {
    const { current, upcoming } = selectConsolidatedVersions(VERSIONS, "2012-01-01");

    expect(current).toBe(null);
    expect(upcoming).toHaveLength(3);
  });

  it("survives missing, malformed and absent input", () => {
    expect(selectConsolidatedVersions(undefined).current).toBe(null);
    expect(selectConsolidatedVersions([{ celex: "x" }, null, { date: "2020-01-01" }]).all).toEqual([]);
  });
});

describe("summarizeAmendments", () => {
  it("counts only entries that amended the text", () => {
    const summary = summarizeAmendments([
      { type: "corrigendum", date: "2018-05-23" },
      { type: "amendment", date: "2019-06-07" },
      { type: "amendment", date: "2024-03-01" },
    ]);

    expect(summary.count).toBe(2);
    expect(summary.latestDate).toBe("2024-03-01");
  });

  it("reports nothing for a corrigendum-only act, so the GDPR gets no warning", () => {
    const summary = summarizeAmendments([
      { type: "corrigendum", date: "2018-05-23" },
      { type: "corrigendum", date: "2021-03-04" },
    ]);

    expect(summary.count).toBe(0);
    expect(summary.latestDate).toBe(null);
  });

  it("counts undated amendments without inventing a date", () => {
    const summary = summarizeAmendments([{ type: "amendment", date: null }]);

    expect(summary.count).toBe(1);
    expect(summary.latestDate).toBe(null);
  });
});

describe("todayIso", () => {
  it("formats the local calendar day, zero-padded", () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
