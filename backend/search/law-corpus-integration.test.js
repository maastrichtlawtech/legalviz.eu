const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { extractOfficialTitleAndExcerpt } = require("./search-build");
const { writeCorpusXml } = require("./law-corpus-store");

const SAMPLE_FMX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ACT>
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
  <TITLE><TI><P>Regulation on Widget Automation</P></TI></TITLE>
  <PREAMBLE>
    <GR.CONSID>
      <CONSID><NP><NO.P>(1)</NO.P><TXT>Automated decision-making systems require a harmonised legal framework.</TXT></NP></CONSID>
    </GR.CONSID>
  </PREAMBLE>
  <ENACTING.TERMS>
    <ARTICLE IDENTIFIER="001">
      <TI.ART>Article 1</TI.ART>
      <STI.ART>Subject matter</STI.ART>
      <ALINEA><P>This Regulation lays down harmonised rules on automated decision-making systems.</P></ALINEA>
    </ARTICLE>
  </ENACTING.TERMS>
</ACT>`;

test("extractOfficialTitleAndExcerpt reads the local corpus without any network call", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "legalviz-corpus-int-"));
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network access is not allowed when the corpus is warm");
  };
  try {
    const celex = "32024R0001";
    await writeCorpusXml(dir, celex, SAMPLE_FMX_XML);

    const result = await extractOfficialTitleAndExcerpt(celex, { corpusDir: dir });

    assert.equal(result.title, "Regulation on Widget Automation");
    assert.match(result.excerpt, /harmonised legal framework/i);
    assert.match(result.excerpt, /harmonised rules on automated decision-making systems/i);
  } finally {
    global.fetch = originalFetch;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
