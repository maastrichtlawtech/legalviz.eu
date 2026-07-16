import { describe, expect, it } from "vitest";
import { buildLawDisplayLabel, cleanLawTitle, extractShortLawTitle, formatOfficialReference } from "./lawDisplay.js";

const GDPR_TITLE = "Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 "
  + "on the protection of natural persons with regard to the processing of personal data and on the free "
  + "movement of such data, and repealing Directive 95/46/EC (General Data Protection Regulation) "
  + "(Text with EEA relevance)";

describe("extractShortLawTitle", () => {
  it("pulls the parenthesised short name, skipping EEA boilerplate", () => {
    expect(extractShortLawTitle(GDPR_TITLE)).toBe("General Data Protection Regulation");
  });

  it("returns empty when no usable parenthetical exists", () => {
    expect(extractShortLawTitle("Regulation (EU) 2019/817 of the European Parliament")).toBe("");
    expect(extractShortLawTitle("")).toBe("");
  });
});

describe("formatOfficialReference", () => {
  it("formats a full reference and rejects partial ones", () => {
    expect(formatOfficialReference({ actType: "regulation", year: "2016", number: "679" })).toBe("Regulation (EU) 2016/679");
    expect(formatOfficialReference({ actType: "regulation", year: "2016" })).toBe(null);
    expect(formatOfficialReference(null)).toBe(null);
  });
});

describe("cleanLawTitle", () => {
  it("strips a leading official reference", () => {
    expect(cleanLawTitle("Regulation (EU) 2016/679 of the European Parliament", "Regulation (EU) 2016/679"))
      .toBe("of the European Parliament");
  });
});

describe("buildLawDisplayLabel", () => {
  it("combines short name and CELEX-derived reference", () => {
    const { label, fullTitle } = buildLawDisplayLabel({ celex: "32016R0679", title: GDPR_TITLE });
    expect(label).toBe("General Data Protection Regulation — Regulation (EU) 2016/679");
    expect(fullTitle).toBe(GDPR_TITLE.replace(/\s+/g, " ").trim());
  });

  it("falls back to the reference alone when the title has no short name", () => {
    const { label } = buildLawDisplayLabel({
      celex: "32019R0817",
      title: "Regulation (EU) 2019/817 of the European Parliament and of the Council of 20 May 2019 on establishing a framework for interoperability",
    });
    expect(label).toBe("Regulation (EU) 2019/817");
  });

  it("falls back to title, then celex, for non-standard celexes", () => {
    expect(buildLawDisplayLabel({ celex: "52020PC0001", title: "Some proposal title" }).label).toBe("Some proposal title");
    expect(buildLawDisplayLabel({ celex: "52020PC0001", title: "" }).label).toBe("52020PC0001");
  });
});
