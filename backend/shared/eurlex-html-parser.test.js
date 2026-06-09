const test = require("node:test");
const assert = require("node:assert/strict");

const {
  closeSharedPlaywrightBrowser,
  fetchEurlexHtmlLaw,
  fetchAndParseEurlexHtmlLaw,
  getSharedPlaywrightBrowser,
  getSharedPlaywrightPage,
  isRetriablePlaywrightError,
  parseEurlexHtmlToCombined,
} = require("./eurlex-html-parser");

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Directive 2002/58/EC concerning privacy in electronic communications">
</head>
<body>
  <div id="TexteOnly">
    <p>
      <TXT_TE>
        <p>Directive 2002/58/EC of the European Parliament and of the Council</p>
        <p>of 12 July 2002</p>
        <p>concerning the processing of personal data and the protection of privacy in the electronic communications sector</p>
        <p>Whereas:</p>
        <p>(1) First recital text.</p>
        <p>(2) Second recital text mentioning Article 2.</p>
        <p>Article 1</p>
        <p>Scope</p>
        <p>1. This Directive lays down rules.</p>
        <p>Article 2</p>
        <p>Definitions</p>
        <p>The following definitions shall also apply:</p>
        <p>(a) "user" means any natural person using a service;</p>
        <p>(b) "traffic data" means any data processed for billing.</p>
      </TXT_TE>
    </p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined extracts title, recitals, articles, and definitions", async () => {
  const parsed = await parseEurlexHtmlToCombined(SAMPLE_HTML, "ENG");

  assert.equal(parsed.langCode, "EN");
  assert.equal(parsed.title, "Directive 2002/58/EC concerning privacy in electronic communications");
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Scope");
  assert.match(parsed.articles[0].article_html, /This Directive lays down rules/);
  assert.equal(parsed.definitions.length, 2);
  assert.equal(parsed.definitions[0].term, "user");
  assert.match(parsed.definitions[0].definition, /natural person using a service/i);
});

const STRUCTURED_HTML = `<!DOCTYPE html>
<html lang="EN">
<body>
  <p class="oj-doc-ti">Directive (EU) 2015/2366 of the European Parliament and of the Council</p>
  <div class="eli-subdivision" id="rct_1">
    <table><tr><td>(1)</td><td>First recital text.</td></tr></table>
  </div>
  <div class="eli-subdivision" id="art_1">
    <div class="eli-title">
      <p class="oj-ti-art">Article 1</p>
      <p class="oj-sti-art">Subject matter</p>
    </div>
    <p>This Directive lays down rules.</p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined reuses the legacy structured EUR-Lex HTML layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(STRUCTURED_HTML, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Subject matter");
  assert.equal(parsed.recitals.length, 1);
  assert.equal(parsed.recitals[0].recital_number, "1");
});

const FLAT_DIVISION_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Directive 95/46/EC">
</head>
<body>
  <div id="TexteOnly">
    <p>
      <TXT_TE>
        <p>Article 4</p>
        <p>National law applicable</p>
        <p>1. Each Member State shall apply the national provisions it adopts pursuant to this Directive.</p>
        <p>CHAPTER II GENERAL RULES ON THE LAWFULNESS OF THE PROCESSING OF PERSONAL DATA</p>
        <p>Article 5</p>
        <p>Member States shall, within the limits of the provisions of this Chapter, determine more precisely the conditions under which the processing of personal data is lawful.</p>
        <p>SECTION I</p>
        <p>PRINCIPLES RELATING TO DATA QUALITY</p>
        <p>Article 6</p>
        <p>1. Member States shall provide that personal data must be processed fairly and lawfully.</p>
      </TXT_TE>
    </p>
  </div>
</body>
</html>`;

const LEGISWRITE_COM_HTML = `<!DOCTYPE html>
<html lang="EN">
<body>
  <div class="content">
    <p class="Statut"><span>Proposal for a</span></p>
    <p class="Typedudocument"><span>REGULATION OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</span></p>
    <p class="Titreobjet"><span>ON A SAMPLE MATTER</span></p>
    <p class="li ManualHeading1"><span>1.</span><span>EXPLANATORY MEMORANDUM</span></p>
    <p class="Normal"><span>Some explanatory prose that must not become a recital.</span></p>
    <p class="li ManualConsidrant"><span class="num"><span>(1)</span></span><span>First recital text.</span></p>
    <p class="li ManualConsidrant"><span class="num"><span>(2)</span></span><span>Second recital mentioning Article 2.</span></p>
    <p class="Formuledadoption"><span>HAVE ADOPTED THIS REGULATION:</span></p>
    <p class="SectionTitle"><span>TITLE I</span></p>
    <p class="SectionTitle"><span>GENERAL PROVISIONS</span></p>
    <p class="Titrearticle"><span>Article 1</span><span> <br>Subject matter</span></p>
    <p class="Normal"><span>This Regulation lays down rules.</span></p>
    <p class="Titrearticle"><span>Article 2</span><span> <br>Definitions</span></p>
    <p class="Normal"><span>For the purposes of this Regulation, the following definitions apply.</span></p>
    <p class="Annexetitre"><span>ANNEX </span><span>I</span><br><span>SAMPLE ANNEX</span></p>
    <p class="Normal"><span>Annex body content.</span></p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined parses LegisWrite Commission-proposal layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGISWRITE_COM_HTML, "ENG");

  assert.match(parsed.title, /^Proposal for a REGULATION OF THE EUROPEAN PARLIAMENT/);
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.recitals[0].recital_number, "1");
  assert.match(parsed.recitals[0].recital_text, /First recital text/);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Subject matter");
  assert.equal(parsed.articles[0].division.chapter.number, "TITLE I");
  assert.equal(parsed.articles[0].division.chapter.title, "GENERAL PROVISIONS");
  assert.match(parsed.articles[0].article_html, /This Regulation lays down rules/);
  // Explanatory-memorandum prose before the recitals must not leak into the body.
  assert.ok(parsed.articles.every((a) => !/explanatory prose/i.test(a.article_html)));
  assert.equal(parsed.annexes.length, 1);
  assert.equal(parsed.annexes[0].annex_id, "I");
  assert.match(parsed.annexes[0].annex_html, /Annex body content/);
});

test("parseEurlexHtmlToCombined keeps flat chapter and section headings out of article bodies", async () => {
  const parsed = await parseEurlexHtmlToCombined(FLAT_DIVISION_HTML, "ENG");

  assert.equal(parsed.articles.length, 3);
  assert.match(parsed.articles[0].article_html, /National law applicable/);
  assert.doesNotMatch(parsed.articles[0].article_html, /CHAPTER II/);
  assert.doesNotMatch(parsed.articles[1].article_html, /SECTION I/);
  assert.equal(parsed.articles[1].division.chapter.number, "CHAPTER II");
  assert.equal(
    parsed.articles[1].division.chapter.title,
    "GENERAL RULES ON THE LAWFULNESS OF THE PROCESSING OF PERSONAL DATA"
  );
  assert.equal(parsed.articles[2].division.section.number, "SECTION I");
  assert.equal(parsed.articles[2].division.section.title, "PRINCIPLES RELATING TO DATA QUALITY");
});

const LEGACY_XHTML_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Council Directive 90/314/EEC on package travel, package holidays and package tours">
</head>
<body>
  <p class="doc-ti">COUNCIL DIRECTIVE 90/314/EEC</p>
  <p class="normal">Whereas package travel, package holidays and package tours are an important part of the tourist industry;</p>
  <p class="normal">Whereas the consumer should be protected against misleading information;</p>
  <p class="ti-art"><span class="italic">Article 1</span></p>
  <p class="normal">Objective</p>
  <p class="normal">The purpose of this Directive is to approximate the laws of the Member States.</p>
  <p class="ti-art">Article 2</p>
  <p class="normal">(1) For the purposes of this Directive:</p>
  <p class="normal">(a) "organizer" means the person who organizes packages;</p>
</body>
</html>`;

test("parseEurlexHtmlToCombined supports the older XHTML doc-ti/normal/ti-art layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGACY_XHTML_HTML, "ENG");

  assert.equal(parsed.title, "Council Directive 90/314/EEC on package travel, package holidays and package tours");
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Objective");
  assert.match(parsed.articles[0].article_html, /approximate the laws of the Member States/i);
  assert.equal(parsed.articles[1].article_number, "2");
  assert.match(parsed.articles[1].article_html, /organizer/i);
});

const LEGACY_XHTML_WITH_ANNEX_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Council Directive 93/13/EEC on unfair terms in consumer contracts">
</head>
<body>
  <p class="doc-ti">COUNCIL DIRECTIVE 93/13/EEC</p>
  <p class="normal">Whereas it is necessary to adopt measures progressively establishing the internal market;</p>
  <p class="ti-art"><span class="italic">Article 1</span></p>
  <p class="normal">Purpose</p>
  <p class="normal">The purpose of this Directive is to approximate the laws of the Member States.</p>
  <p class="doc-ti">ANNEX</p>
  <p class="doc-ti">TERMS REFERRED TO IN ARTICLE 3 (3)</p>
  <p class="normal">1. Terms excluding or limiting the legal liability of a seller or supplier.</p>
</body>
</html>`;

test("parseEurlexHtmlToCombined captures annexes from the older XHTML layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGACY_XHTML_WITH_ANNEX_HTML, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.annexes.length, 1);
  assert.equal(parsed.annexes[0].annex_id, "ANNEX — TERMS REFERRED TO IN ARTICLE 3 (3)");
  assert.equal(parsed.annexes[0].annex_title, "ANNEX — TERMS REFERRED TO IN ARTICLE 3 (3)");
  assert.match(parsed.annexes[0].annex_html, /legal liability of a seller or supplier/i);
});

test("fetchAndParseEurlexHtmlLaw always fetches and parses the English fallback", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  try {
    const parsed = await fetchAndParseEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      includeRawHtml: true,
    });

    assert.match(requestedUrl, /\/legal-content\/EN\/TXT\/HTML\/\?uri=CELEX:32002L0058$/);
    assert.equal(parsed.requestedLang, "DEU");
    assert.equal(parsed.servedLang, "ENG");
    assert.equal(parsed.lang, "ENG");
    assert.equal(parsed.langCode, "EN");
    assert.equal(parsed.articles[0].article_number, "1");
    assert.match(parsed.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchEurlexHtmlLaw always fetches raw English HTML without parsing", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  try {
    const fetched = await fetchEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
    });

    assert.match(requestedUrl, /\/legal-content\/EN\/TXT\/HTML\/\?uri=CELEX:32002L0058$/);
    assert.equal(fetched.requestedLang, "DEU");
    assert.equal(fetched.servedLang, "ENG");
    assert.equal(fetched.lang, "ENG");
    assert.equal(fetched.source, "eurlex-html");
    assert.match(fetched.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseEurlexHtmlLaw surfaces EUR-Lex WAF challenges as a distinct client error", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    await assert.rejects(
      () => fetchAndParseEurlexHtmlLaw({
        celex: "31990L0314",
        lang: "ENG",
        eurlexBase: "https://eur-lex.europa.eu",
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.equal(error.code, "eurlex_html_challenged");
        assert.equal(error.statusCode, 503);
        assert.equal(error.details.celex, "31990L0314");
        assert.equal(error.details.upstreamStatus, 202);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseEurlexHtmlLaw can use Playwright on challenge when enabled", async () => {
  const originalFetch = global.fetch;
  let playwrightCalled = false;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    const parsed = await fetchAndParseEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      usePlaywrightOnChallenge: true,
      playwrightHeadless: false,
      fetchWithPlaywrightImpl: async ({ headless }) => {
        playwrightCalled = true;
        assert.equal(headless, false);
        return SAMPLE_HTML;
      },
    });

    assert.equal(playwrightCalled, true);
    assert.equal(parsed.requestedLang, "DEU");
    assert.equal(parsed.servedLang, "ENG");
    assert.equal(parsed.articles[0].article_number, "1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchEurlexHtmlLaw can use Playwright on challenge when enabled", async () => {
  const originalFetch = global.fetch;
  let playwrightCalled = false;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    const fetched = await fetchEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      usePlaywrightOnChallenge: true,
      playwrightHeadless: false,
      fetchWithPlaywrightImpl: async ({ headless }) => {
        playwrightCalled = true;
        assert.equal(headless, false);
        return SAMPLE_HTML;
      },
    });

    assert.equal(playwrightCalled, true);
    assert.equal(fetched.requestedLang, "DEU");
    assert.equal(fetched.servedLang, "ENG");
    assert.match(fetched.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("isRetriablePlaywrightError matches transient browser-closure failures", () => {
  assert.equal(isRetriablePlaywrightError(new Error("page.content: Target page, context or browser has been closed")), true);
  assert.equal(isRetriablePlaywrightError(new Error("Page crashed")), true);
  assert.equal(isRetriablePlaywrightError(new Error("No browser found")), false);
});

test("getSharedPlaywrightBrowser reuses the same browser for the same config", async () => {
  let launches = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {},
  };
  const playwright = {
    chromium: {
      launch: async ({ headless }) => {
        launches += 1;
        assert.equal(headless, false);
        return browser;
      },
    },
  };

  try {
    const first = await getSharedPlaywrightBrowser(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    const second = await getSharedPlaywrightBrowser(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    assert.equal(first, browser);
    assert.equal(second, browser);
    assert.equal(launches, 1);
  } finally {
    await closeSharedPlaywrightBrowser();
  }
});

test("getSharedPlaywrightPage reuses the same page for the same shared browser", async () => {
  let pageCreates = 0;
  const page = {
    isClosed: () => false,
  };
  const browser = {
    isConnected: () => true,
    close: async () => {},
    newPage: async () => {
      pageCreates += 1;
      return page;
    },
  };
  const playwright = {
    chromium: {
      launch: async () => browser,
    },
  };

  try {
    const first = await getSharedPlaywrightPage(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    const second = await getSharedPlaywrightPage(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    assert.equal(first, page);
    assert.equal(second, page);
    assert.equal(pageCreates, 1);
  } finally {
    await closeSharedPlaywrightBrowser();
  }
});
