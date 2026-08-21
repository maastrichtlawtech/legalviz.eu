import { describe, it, expect } from "vitest";
import { earliestEntryIntoForce, lawStatus, todayIso } from "./lawStatus.js";

const TODAY = "2026-08-21";

describe("lawStatus", () => {
  it("reports an act in force", () => {
    expect(lawStatus({ inForce: true }, TODAY)).toBe("inForce");
    // A future entry date on an act already in force does not unseat that: the
    // later dates stage individual provisions.
    expect(lawStatus({ inForce: true, entryIntoForce: "2036-08-31" }, TODAY)).toBe("inForce");
  });

  // The distinction the whole module exists for. Both of these carry
  // `inForce: false`, and they mean opposite things.
  it("separates an act not yet in force from one no longer in force", () => {
    // Regulation (EU) 2026/1818 as Cellar answers it: in-force 0, entry 2026-08-30.
    expect(lawStatus({ inForce: false, entryIntoForce: "2026-08-30" }, TODAY)).toBe("notYetInForce");
    // Regulation 729/70: entered into force 1970, ran out in 1999.
    expect(lawStatus({ inForce: false, entryIntoForce: "1970-05-18" }, TODAY)).toBe("notInForce");
  });

  it("treats an act entering into force today as in effect, not upcoming", () => {
    expect(lawStatus({ inForce: false, entryIntoForce: TODAY }, TODAY)).toBe("notInForce");
  });

  it("falls back to the weaker state when there is no entry date", () => {
    // Records published before entryIntoForce was fetched, and the acts Cellar
    // has no entry date for (~3%). Never guess "not yet" without a date.
    expect(lawStatus({ inForce: false }, TODAY)).toBe("notInForce");
    expect(lawStatus({ inForce: false, entryIntoForce: null }, TODAY)).toBe("notInForce");
  });

  it("draws nothing when Cellar has no status", () => {
    // ~13% of the corpus: no in-force triple at all. Labelling either way would
    // be an assertion the data does not support.
    expect(lawStatus({ inForce: null }, TODAY)).toBe(null);
    expect(lawStatus({}, TODAY)).toBe(null);
    expect(lawStatus(null, TODAY)).toBe(null);
  });
});

describe("earliestEntryIntoForce", () => {
  it("takes the earliest of several staged dates", () => {
    // The live metadata query returns an array; 32026R1818 carries ten dates.
    expect(earliestEntryIntoForce(["2030-07-01", "2026-08-30", "2036-08-31"])).toBe("2026-08-30");
    // The GDPR: entry into force, then start of application.
    expect(earliestEntryIntoForce(["2016-05-24", "2018-05-25"])).toBe("2016-05-24");
  });

  it("accepts a bare string as well as an array", () => {
    expect(earliestEntryIntoForce("2016-05-24")).toBe("2016-05-24");
  });

  it("takes the date part of a timestamp and ignores anything unparseable", () => {
    expect(earliestEntryIntoForce(["2016-05-24T00:00:00Z"])).toBe("2016-05-24");
    expect(earliestEntryIntoForce(["", null, undefined, "not a date"])).toBe(null);
    expect(earliestEntryIntoForce([])).toBe(null);
    expect(earliestEntryIntoForce(undefined)).toBe(null);
  });

  // Cellar answers 32026D1296 with 1001-01-01. It is not a real date, but it is
  // safely in the past, so it can only ever read as "not yet in force: no".
  it("does not turn a placeholder year into an upcoming act", () => {
    expect(lawStatus({ inForce: false, entryIntoForce: "1001-01-01" }, TODAY)).toBe("notInForce");
  });
});

describe("todayIso", () => {
  it("formats as a comparable ISO date", () => {
    expect(todayIso(new Date("2026-08-21T23:30:00Z"))).toBe("2026-08-21");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
