import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { parseFormexToCombined } from "../src/utils/parsers.js";
import { toApiLang } from "../src/utils/formexApi.js";
import { getBundledLaws } from "../src/utils/lawRouting.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const siteUrl = "https://legalviz.eu";
const FEATURED_LAWS = getBundledLaws();

function installDomGlobals() {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.DOMParser = window.DOMParser;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, "navigator", {
      value: window.navigator,
      configurable: true,
    });
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(value = "", maxLength = 160) {
  const text = stripHtml(value);
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function getValidAnnexes(data) {
  return (data?.annexes || []).filter((annex) => String(annex?.annex_id || "").trim());
}

function getArticleTotal(law, data) {
  return data?.articles?.length || law.articles || 0;
}

function getRecitalTotal(law, data) {
  return data?.recitals?.length || law.recitals || 0;
}

function readBuiltIndexHtml() {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Expected built index at ${indexPath}`);
  }
  return fs.readFileSync(indexPath, "utf8");
}

function getApiBase() {
  return process.env.PRERENDER_FORMEX_API_BASE
    || process.env.VITE_FORMEX_API_BASE
    || "https://api.legalviz.eu";
}

async function fetchLawData(law, lang = "EN") {
  if (!law.celex) return null;

  const url = `${getApiBase()}/api/laws/${encodeURIComponent(law.celex)}?lang=${toApiLang(lang)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed for ${law.slug}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let xmlText;
  if (contentType.includes("application/json")) {
    const json = await response.json();
    xmlText = json.xml || json.content || json.data || "";
  } else {
    xmlText = await response.text();
  }

  if (!xmlText) {
    throw new Error(`No XML returned for ${law.slug}`);
  }

  return parseFormexToCombined(xmlText);
}

function buildLawBody(law, data) {
  const articleTotal = getArticleTotal(law, data);
  const recitalTotal = getRecitalTotal(law, data);
  const annexes = getValidAnnexes(data);
  const articleLinks = Array.from({ length: articleTotal }, (_, index) => {
    const number = String(index + 1);
    return `<li><a href="/${law.slug}/article/${number}">Article ${number}</a></li>`;
  }).join("");

  const recitalLinks = Array.from({ length: recitalTotal }, (_, index) => {
    const number = String(index + 1);
    return `<li><a href="/${law.slug}/recital/${number}">Recital ${number}</a></li>`;
  }).join("");

  const annexLinks = annexes.map((annex) => (
    `<li><a href="/${law.slug}/annex/${encodeURIComponent(annex.annex_id)}">Annex ${escapeHtml(annex.annex_id)}</a></li>`
  )).join("");

  const summary = data
    ? `<p>LegalViz.EU is a reading tool for EU legislation. Use this page to browse ${escapeHtml(data.title || law.label)} by article, recital, and annex, then open the full interactive viewer for cross-references, side-by-side reading, and printing.</p>`
    : `<p>LegalViz.EU is a reading tool for EU legislation. Use this page to browse ${escapeHtml(law.label)} and open the full interactive viewer for easier navigation.</p>`;

  return `
    <main class="lv-prerender">
      <nav class="lv-breadcrumbs">
        <a href="/">Home</a>
      </nav>
      <header>
        <p class="lv-kicker">EU law reading tool</p>
        <h1>${escapeHtml(data?.title || law.label)}</h1>
        ${summary}
      </header>
      <section class="lv-callout">
        <p><strong>What LegalViz.EU helps with:</strong> faster reading of EU laws, quick jumps between articles and recitals, and easier orientation inside long regulations.</p>
      </section>
      <section>
        <h2>Articles</h2>
        <ol>${articleLinks}</ol>
      </section>
      <section>
        <h2>Recitals</h2>
        <ol>${recitalLinks}</ol>
      </section>
      ${annexLinks ? `
      <section>
        <h2>Annexes</h2>
        <ol>${annexLinks}</ol>
      </section>` : ""}
    </main>
  `;
}

function buildNearbyNumberLinks(law, data, kind, currentNumber, total) {
  const current = Number(currentNumber);
  const items = [];
  const articleTotal = getArticleTotal(law, data);
  const recitalTotal = getRecitalTotal(law, data);

  if (current > 1) {
    items.push(`<a href="/${law.slug}/${kind}/${current - 1}">${kind === "article" ? "Previous article" : "Previous recital"}</a>`);
  }
  if (current < total) {
    items.push(`<a href="/${law.slug}/${kind}/${current + 1}">${kind === "article" ? "Next article" : "Next recital"}</a>`);
  }
  if (kind !== "article" && articleTotal > 0) {
    items.push(`<a href="/${law.slug}/article/1">Start with Article 1</a>`);
  }
  if (kind !== "recital" && recitalTotal > 0) {
    items.push(`<a href="/${law.slug}/recital/1">Start with Recital 1</a>`);
  }

  return items.length ? `<p class="lv-inline-links">${items.join(" · ")}</p>` : "";
}

function buildArticleBody(law, data, articleNumber) {
  const article = data?.articles?.find((entry) => String(entry.article_number) === String(articleNumber));
  const displayTitle = article?.article_title
    ? `Article ${articleNumber} - ${article.article_title}`
    : `Article ${articleNumber}`;
  const articleTotal = getArticleTotal(law, data);
  const annexes = getValidAnnexes(data);
  const annexLinks = annexes.slice(0, 6).map((annex) => (
    `<li><a href="/${law.slug}/annex/${encodeURIComponent(annex.annex_id)}">Annex ${escapeHtml(annex.annex_id)}</a></li>`
  )).join("");

  return `
    <main class="lv-prerender">
      <nav class="lv-breadcrumbs">
        <a href="/">Home</a>
        <span>/</span>
        <a href="/${law.slug}">${escapeHtml(data?.title || law.label)}</a>
      </nav>
      <header>
        <p class="lv-kicker">EU law article</p>
        <h1>${escapeHtml(displayTitle)}</h1>
        <p>This page is part of LegalViz.EU, a tool that makes EU legislation easier to read by linking articles, recitals, and related references.</p>
      </header>
      <section class="lv-callout">
        <p><strong>Navigate this law:</strong> <a href="/${law.slug}">Law overview</a> · <a href="/${law.slug}/recital/1">Recitals</a>${annexLinks ? ` · <a href="/${law.slug}/annex/${encodeURIComponent(annexes[0].annex_id)}">Annexes</a>` : ""}</p>
        ${buildNearbyNumberLinks(law, data, "article", articleNumber, articleTotal)}
      </section>
      ${article?.article_html
        ? `<article class="lv-content">${article.article_html}</article>`
        : `<p>Open the interactive view to read Article ${escapeHtml(articleNumber)}.</p>`}
      ${annexLinks ? `
      <section>
        <h2>Related annexes</h2>
        <ol>${annexLinks}</ol>
      </section>` : ""}
    </main>
  `;
}

function buildRecitalBody(law, data, recitalNumber) {
  const recital = data?.recitals?.find((entry) => String(entry.recital_number) === String(recitalNumber));
  const recitalTotal = getRecitalTotal(law, data);
  const annexes = getValidAnnexes(data);

  return `
    <main class="lv-prerender">
      <nav class="lv-breadcrumbs">
        <a href="/">Home</a>
        <span>/</span>
        <a href="/${law.slug}">${escapeHtml(data?.title || law.label)}</a>
      </nav>
      <header>
        <p class="lv-kicker">EU law recital</p>
        <h1>Recital ${escapeHtml(recitalNumber)}</h1>
        <p>This page is part of LegalViz.EU, a tool that helps readers move through EU legislation more quickly and understand its structure.</p>
      </header>
      <section class="lv-callout">
        <p><strong>Navigate this law:</strong> <a href="/${law.slug}">Law overview</a> · <a href="/${law.slug}/article/1">Articles</a>${annexes.length ? ` · <a href="/${law.slug}/annex/${encodeURIComponent(annexes[0].annex_id)}">Annexes</a>` : ""}</p>
        ${buildNearbyNumberLinks(law, data, "recital", recitalNumber, recitalTotal)}
      </section>
      ${recital?.recital_html
        ? `<article class="lv-content">${recital.recital_html}</article>`
        : `<p>Open the interactive view to read Recital ${escapeHtml(recitalNumber)}.</p>`}
    </main>
  `;
}

function buildAnnexBody(law, data, annexId) {
  const annex = getValidAnnexes(data).find((entry) => String(entry.annex_id) === String(annexId));
  const displayTitle = annex?.annex_title
    ? `Annex ${annexId} - ${annex.annex_title}`
    : `Annex ${annexId}`;

  return `
    <main class="lv-prerender">
      <nav class="lv-breadcrumbs">
        <a href="/">Home</a>
        <span>/</span>
        <a href="/${law.slug}">${escapeHtml(data?.title || law.label)}</a>
      </nav>
      <header>
        <p class="lv-kicker">EU law annex</p>
        <h1>${escapeHtml(displayTitle)}</h1>
        <p>This annex is part of the LegalViz.EU reading tool for EU legislation, with quick access back to the law overview, articles, and recitals.</p>
      </header>
      <section class="lv-callout">
        <p><strong>Navigate this law:</strong> <a href="/${law.slug}">Law overview</a> · <a href="/${law.slug}/article/1">Articles</a> · <a href="/${law.slug}/recital/1">Recitals</a></p>
      </section>
      ${annex?.annex_html
        ? `<article class="lv-content">${annex.annex_html}</article>`
        : `<p>Open the interactive view to read Annex ${escapeHtml(annexId)}.</p>`}
    </main>
  `;
}

function buildSeoPayload({ title, description, canonical, type = "article", schemaType = "WebPage", ogTitle = title }) {
  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta property="og:type" content="${escapeHtml(type)}" />
    <meta property="og:title" content="${escapeHtml(ogTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": schemaType,
      name: title,
      description,
      url: canonical,
    })}</script>
  `;
}

function buildPageHtml(template, { title, description, canonical, bodyHtml, type, schemaType, ogTitle }) {
  const seoPayload = buildSeoPayload({ title, description, canonical, type, schemaType, ogTitle });
  const rootHtml = `
    <div id="root">${bodyHtml}</div>
    <style>
      .lv-prerender { max-width: 900px; margin: 0 auto; padding: 32px 20px 48px; color: #111827; font: 16px/1.6 Georgia, "Times New Roman", serif; }
      .lv-prerender a { color: #003399; text-decoration: none; }
      .lv-prerender a:hover { text-decoration: underline; }
      .lv-kicker { margin: 0 0 8px; font: 600 12px/1.2 system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #4b5563; }
      .lv-prerender h1, .lv-prerender h2 { line-height: 1.2; color: #111827; }
      .lv-prerender h1 { margin: 0 0 16px; font-size: 2rem; }
      .lv-prerender h2 { margin-top: 32px; font-size: 1.25rem; }
      .lv-breadcrumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; font: 500 14px/1.4 system-ui, sans-serif; color: #4b5563; }
      .lv-callout { margin: 24px 0; padding: 16px 18px; border: 1px solid #dbe4ff; border-radius: 16px; background: #f6f8ff; }
      .lv-inline-links { margin: 12px 0 0; font: 500 14px/1.6 system-ui, sans-serif; }
      .lv-content p, .lv-content li { margin: 0 0 1em; }
      .lv-content ol, .lv-content ul { padding-left: 1.5rem; }
    </style>
  `;

  const cleanedTemplate = template
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:type"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:title"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:description"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:url"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:card"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:title"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:description"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "")
    .replace(/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>\s*/gi, "");

  return cleanedTemplate
    .replace(/<\/head>/i, `${seoPayload}\n  </head>`)
    .replace(/<div id="root"><\/div>/i, rootHtml);
}

function writePage(routePath, html) {
  const targetDir = path.join(distDir, routePath.replace(/^\//, ""));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "index.html"), html);
}

async function buildLawPages(template, law) {
  let data = null;
  try {
    data = await fetchLawData(law);
    console.log(`[prerender] Loaded ${law.slug} from remote source`);
  } catch (error) {
    console.warn(`[prerender] Falling back to metadata-only page for ${law.slug}: ${error.message}`);
  }

  const lawTitle = data?.title || law.label;
  const overviewDescription = data
    ? summarize(`Use LegalViz.EU to read ${lawTitle} more easily. Browse articles, recitals, annexes, and law structure on one page.`)
    : summarize(`Use LegalViz.EU to browse ${law.label} by article, recital, and annex.`);

  writePage(`/${law.slug}`, buildPageHtml(template, {
    title: `Read ${lawTitle} more easily | LegalViz.EU`,
    description: overviewDescription,
    canonical: `${siteUrl}/${law.slug}/`,
    bodyHtml: buildLawBody(law, data),
  }));

  const articleTotal = getArticleTotal(law, data);
  const recitalTotal = getRecitalTotal(law, data);

  for (let index = 1; index <= articleTotal; index += 1) {
    const article = data?.articles?.find((entry) => String(entry.article_number) === String(index));
    const articleTitle = article?.article_title
      ? `Read Article ${index}: ${article.article_title} | ${lawTitle} | LegalViz.EU`
      : `Read Article ${index} | ${lawTitle} | LegalViz.EU`;
    const articleDescription = summarize(article?.article_html || `Read Article ${index} of ${lawTitle} with LegalViz.EU, a tool for easier navigation of EU legislation.`);

    writePage(`/${law.slug}/article/${index}`, buildPageHtml(template, {
      title: articleTitle,
      description: articleDescription,
      canonical: `${siteUrl}/${law.slug}/article/${index}/`,
      bodyHtml: buildArticleBody(law, data, index),
    }));
  }

  for (let index = 1; index <= recitalTotal; index += 1) {
    const recital = data?.recitals?.find((entry) => String(entry.recital_number) === String(index));
    const recitalTitle = `Read Recital ${index} | ${lawTitle} | LegalViz.EU`;
    const recitalDescription = summarize(recital?.recital_html || `Read Recital ${index} of ${lawTitle} with LegalViz.EU, a tool for easier navigation of EU legislation.`);

    writePage(`/${law.slug}/recital/${index}`, buildPageHtml(template, {
      title: recitalTitle,
      description: recitalDescription,
      canonical: `${siteUrl}/${law.slug}/recital/${index}/`,
      bodyHtml: buildRecitalBody(law, data, index),
    }));
  }

  for (const annex of getValidAnnexes(data)) {
    const annexTitle = annex?.annex_title
      ? `Read Annex ${annex.annex_id}: ${annex.annex_title} | ${lawTitle} | LegalViz.EU`
      : `Read Annex ${annex.annex_id} | ${lawTitle} | LegalViz.EU`;
    const annexDescription = summarize(annex?.annex_html || `Read Annex ${annex.annex_id} of ${lawTitle} with LegalViz.EU.`);

    writePage(`/${law.slug}/annex/${encodeURIComponent(annex.annex_id)}`, buildPageHtml(template, {
      title: annexTitle,
      description: annexDescription,
      canonical: `${siteUrl}/${law.slug}/annex/${encodeURIComponent(annex.annex_id)}/`,
      bodyHtml: buildAnnexBody(law, data, annex.annex_id),
    }));
  }
}

function buildHomeBody(laws) {
  const lawLinks = laws
    .filter((law) => law.slug)
    .map((law) => `<li><a href="/${law.slug}/">${escapeHtml(law.label)}</a></li>`)
    .join("");

  return `
    <main class="lv-prerender">
      <header>
        <p class="lv-kicker">EU law reading tool</p>
        <h1>Read EU law beautifully, and with ease.</h1>
        <p>LegalViz.EU is a free reader for EU legislation. Search primary EU acts by title, reference, or CELEX, then move quickly between articles, recitals, annexes, and cross-references — all in one clean, readable view.</p>
      </header>
      <section class="lv-callout">
        <p><strong>What LegalViz.EU helps with:</strong> faster reading of EU laws like the GDPR, AI Act, DMA, DSA and Data Act, quick jumps between articles and recitals, side-by-side reading, and print/PDF export.</p>
      </section>
      <section>
        <h2>Popular EU laws</h2>
        <ul>${lawLinks}</ul>
      </section>
    </main>
  `;
}

function buildHomePage(template, laws) {
  const description = "Read EU laws like the GDPR, AI Act, DMA, DSA and Data Act with ease. Navigate articles, recitals, annexes and cross-references, side by side.";
  const html = buildPageHtml(template, {
    title: "LegalViz.EU — Read EU law: GDPR, AI Act, DMA, DSA & more",
    ogTitle: "LegalViz.EU — Read EU law beautifully",
    description,
    canonical: `${siteUrl}/`,
    bodyHtml: buildHomeBody(laws),
    type: "website",
    schemaType: "WebSite",
  });
  fs.writeFileSync(path.join(distDir, "index.html"), html);
  console.log("[prerender] Generated static homepage");
}

async function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Missing dist directory at ${distDir}. Run vite build first.`);
  }

  installDomGlobals();
  const template = readBuiltIndexHtml();

  for (const law of FEATURED_LAWS) {
    await buildLawPages(template, law);
  }

  buildHomePage(template, FEATURED_LAWS);

  console.log(`[prerender] Generated static pages for ${FEATURED_LAWS.length} flagship laws`);
}

main().catch((error) => {
  console.error("[prerender] Failed:", error);
  process.exitCode = 1;
});
