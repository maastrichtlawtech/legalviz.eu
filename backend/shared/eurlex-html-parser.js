const { JSDOM } = require("jsdom");
const { createRequire } = require("module");

const { ClientError } = require("./api-utils");

const LANG_3_TO_2 = {
  BUL: "BG",
  CES: "CS",
  DAN: "DA",
  DEU: "DE",
  ELL: "EL",
  ENG: "EN",
  EST: "ET",
  FIN: "FI",
  FRA: "FR",
  GLE: "GA",
  HRV: "HR",
  HUN: "HU",
  ITA: "IT",
  LAV: "LV",
  LIT: "LT",
  MLT: "MT",
  NLD: "NL",
  POL: "PL",
  POR: "PT",
  RON: "RO",
  SLK: "SK",
  SLV: "SL",
  SPA: "ES",
  SWE: "SV",
};

let helperPromise = null;
const requireFromHere = createRequire(__filename);
const DEFAULT_PLAYWRIGHT_RETRIES = 3;
const DEFAULT_BROWSER_IDLE_MS = 30_000; // close browser after 30s idle to save RAM
let sharedPlaywrightBrowser = null;
let sharedPlaywrightBrowserKey = null;
let sharedPlaywrightPage = null;
let browserIdleTimer = null;

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripLeadingMarker(text, markerRegex) {
  return normalizeText(String(text || "").replace(markerRegex, ""));
}

function isArticleHeading(text) {
  return /^Article\s+\d+[A-Za-z]*$/i.test(text);
}

function isAnnexHeading(text) {
  return /^ANNEX(?:\s+[IVXLCDM0-9A-Za-z]+)?$/i.test(text);
}

function isLikelyArticleTitle(text) {
  if (!text) return false;
  if (isArticleHeading(text) || isAnnexHeading(text)) return false;
  if (/^\d+\./.test(text)) return false;
  if (/^\([a-z0-9ivxlcdm]+\)/i.test(text)) return false;
  if (text.length > 180) return false;
  return !/[.;!?]$/.test(text);
}

function parseDivisionMarker(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const match = normalized.match(/^(TITLE|CHAPTER|SECTION)\s+([IVXLCDM0-9A-Z]+)(?:\s+(.*))?$/i);
  if (!match) return null;

  return {
    kind: match[1].toLowerCase(),
    number: `${match[1].toUpperCase()} ${match[2]}`,
    title: normalizeText(match[3] || ""),
  };
}

function isLikelyDivisionTitle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (isArticleHeading(normalized) || isAnnexHeading(normalized) || parseDivisionMarker(normalized)) return false;
  if (normalized.length > 220) return false;
  const letters = normalized.replace(/[^A-Za-z]/g, "");
  if (!letters) return false;
  return normalized === normalized.toUpperCase();
}

function paragraphsToHtml(paragraphs, { title = null } = {}) {
  const html = [];
  if (title) {
    html.push(`<p class="oj-sti-art">${escapeHtml(title)}</p>`);
  }
  paragraphs
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
    .forEach((paragraph) => {
      html.push(`<p>${escapeHtml(paragraph)}</p>`);
    });
  return html.join("");
}

function formatStructuredTitle(text, langConfig) {
  if (!text) return "";
  let short = String(text || "");
  if (langConfig?.titleSplit) {
    short = short.split(langConfig.titleSplit)[0];
  }
  return normalizeText(short)
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (match) => match.toUpperCase())
    .replace(/\b(Eu|Ec|Eec|Euratom|Ue|We)\b/gi, (match) => match.toUpperCase());
}

function parseStructuredHtmlDefinitions(articleHtml, langConfig, parser) {
  const definitions = [];
  const doc = parser.parseFromString(articleHtml, "text/html");
  const tables = doc.querySelectorAll("table");
  const meansRegex = langConfig?.meansVerb
    ? new RegExp(`^[${langConfig.quoteChars || "\\u2018\\u2019'\""}]?([^${langConfig.quoteChars || "\\u2018\\u2019'\"" }]+)[${langConfig.quoteChars || "\\u2018\\u2019'\""}]?\\s+(?:${langConfig.meansVerb})\\s+`, "i")
    : null;

  for (const table of tables) {
    const cells = table.querySelectorAll("td");
    if (cells.length < 2) continue;
    const text = normalizeText(cells[1].textContent);
    if (!text) continue;

    if (meansRegex) {
      const match = text.match(meansRegex);
      if (match) {
        definitions.push({
          term: normalizeText(match[1]),
          definition: normalizeText(text.replace(match[0], "")),
        });
      }
    }
  }

  return definitions;
}

function parseStructuredHtmlToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const getText = (element) => normalizeText(element?.textContent || "");
  const innerHTML = (element) => (
    element
      ? Array.from(element.childNodes)
        .map((node) => (node.nodeType === 1 ? node.outerHTML : node.textContent))
        .join("")
      : ""
  );

  const articles = [];
  const recitals = [];
  const annexes = [];
  const parser = new global.DOMParser();

  let title = "";
  const titleEl = document.querySelector(".oj-doc-ti, .doc-ti, .title-doc-first");
  const mainTitle = titleEl ? formatStructuredTitle(getText(titleEl), langConfig) : "";
  let shortTitle = "";
  for (const element of document.querySelectorAll(".oj-doc-ti, .doc-ti")) {
    const match = getText(element).match(/\(([^)]+)\)$/);
    if (!match) continue;
    const candidate = normalizeText(match[1]);
    if (
      candidate.length > 3 &&
      candidate.length < 100 &&
      !(langConfig?.eea?.test(candidate))
    ) {
      shortTitle = candidate;
      break;
    }
  }
  title = shortTitle && mainTitle && !mainTitle.includes(shortTitle)
    ? `${shortTitle} — ${mainTitle}`
    : shortTitle || mainTitle;

  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let pendingHeader = null;

  const walker = document.createTreeWalker(document.body || document, global.NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const element = walker.currentNode;
    if (!element || element.nodeType !== 1) continue;

    if (
      element.tagName === "P" &&
      (element.classList.contains("title-division-1") || element.classList.contains("oj-ti-section-1"))
    ) {
      const text = getText(element);
      if (langConfig?.chapter?.test(text)) {
        currentChapter = { number: text, title: "" };
        currentSection = { number: "", title: "" };
        pendingHeader = "chapter";
      } else if (langConfig?.section?.test(text)) {
        currentSection = { number: text, title: "" };
        pendingHeader = "section";
      } else {
        currentChapter = { number: text, title: "" };
        currentSection = { number: "", title: "" };
        pendingHeader = "chapter";
      }
    }

    if (
      element.tagName === "P" &&
      (element.classList.contains("title-division-2") || element.classList.contains("oj-ti-section-2"))
    ) {
      const text = getText(element);
      if (pendingHeader === "chapter") currentChapter.title = text;
      if (pendingHeader === "section") currentSection.title = text;
      pendingHeader = null;
    }

    if (element.tagName === "DIV" && element.classList.contains("eli-subdivision") && String(element.id || "").startsWith("rct_")) {
      const cells = element.querySelectorAll("table td");
      if (cells.length >= 2) {
        const numberMatch = getText(cells[0]).match(/\(?\s*(\d+)\s*\)?/);
        const recital_number = numberMatch ? numberMatch[1] : getText(cells[0]) || String(recitals.length + 1);
        const recitalHtml = innerHTML(cells[1]);
        recitals.push({
          recital_number,
          recital_text: getText(cells[1]),
          recital_html: injectCrossRefLinks(recitalHtml, langConfig),
        });
      }
      continue;
    }

    if (element.tagName === "P" && element.classList.contains("oj-ti-art")) {
      let container = element.parentElement;
      while (container && !(container.tagName === "DIV" && container.classList.contains("eli-subdivision"))) {
        container = container.parentElement;
      }
      const numberMatch = getText(element).match(langConfig?.article || /Article\s+(\d+[a-z]*)/i);
      const article_number = numberMatch ? numberMatch[1] : getText(element);
      const titleBlock = container ? container.querySelector("div.eli-title p.oj-sti-art") : null;
      const article_title = titleBlock ? getText(titleBlock) : "";
      articles.push({
        article_number,
        article_title,
        division: {
          chapter: { number: currentChapter.number, title: currentChapter.title },
          section: currentSection.number ? { number: currentSection.number, title: currentSection.title } : null,
        },
        article_html: injectCrossRefLinks(innerHTML(container || element.parentElement), langConfig),
      });
      continue;
    }

    if (element.tagName === "DIV" && element.classList.contains("eli-subdivision")) {
      const numParagraph = element.querySelector("p.title-article-norm");
      if (numParagraph) {
        const numberMatch = getText(numParagraph).match(langConfig?.article || /Article\s+(\d+[a-z]*)/i);
        const article_number = numberMatch ? numberMatch[1] : getText(numParagraph);
        const titleParagraph = element.querySelector("p.stitle-article-norm");
        const article_title = titleParagraph ? getText(titleParagraph) : "";
        articles.push({
          article_number,
          article_title,
          division: {
            chapter: { number: currentChapter.number, title: currentChapter.title },
            section: currentSection.number ? { number: currentSection.number, title: currentSection.title } : null,
          },
          article_html: injectCrossRefLinks(innerHTML(element), langConfig),
        });
      }
    }

    if (element.tagName === "P") {
      const text = getText(element);
      const looksLikeAnnex =
        (langConfig?.annex?.test(text)) ||
        element.classList.contains("oj-ti-annex") ||
        element.classList.contains("oj-ti-annex-1") ||
        element.classList.contains("title-annex-norm");

      if (looksLikeAnnex) {
        let annexTitle = text;
        let subtitle = element.parentElement?.querySelector("div.eli-title p, p.oj-ti-annex-2, p.stitle-annex-norm");
        if (!subtitle) {
          const next = element.nextElementSibling;
          if (next && next.tagName === "P" && (next.classList.contains("oj-doc-ti") || next.classList.contains("oj-normal"))) {
            subtitle = next;
          }
        }
        if (subtitle) annexTitle = `${text} — ${getText(subtitle)}`;

        let container = element.parentElement;
        while (container && !(container.tagName === "DIV" && container.classList.contains("eli-subdivision"))) {
          container = container.parentElement;
        }
        const root = container || element.parentElement || element;
        const annexMatch = text.match(langConfig?.annexCapture || /^ANNEX\s*([IVXLC]+|\d+)?/i);
        const annex_id = annexMatch ? normalizeText(annexMatch[1] || "") || annexTitle : annexTitle;
        annexes.push({
          annex_id,
          annex_title: annexTitle,
          annex_html: injectCrossRefLinks(innerHTML(root), langConfig),
        });
      }
    }
  }

  const definitionsArticle = articles.find((article) => article.article_title && langConfig?.definition?.test(article.article_title));
  const definitions = definitionsArticle
    ? parseStructuredHtmlDefinitions(definitionsArticle.article_html, langConfig, parser)
    : [];

  recitals.sort((left, right) => {
    const leftNum = Number.parseInt(String(left.recital_number).replace(/\D+/g, ""), 10) || 0;
    const rightNum = Number.parseInt(String(right.recital_number).replace(/\D+/g, ""), 10) || 0;
    return leftNum - rightNum;
  });

  return {
    title,
    articles,
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

function parseDefinitions(article) {
  if (!/definitions?/i.test(article?.article_title || "")) {
    return [];
  }

  return article.bodyParagraphs
    .map((paragraph) => normalizeText(paragraph))
    .map((paragraph) => paragraph.match(/^\(([a-z])\)\s+(.*)$/i)?.[2] || null)
    .filter(Boolean)
    .map((entryText) => {
      const quoted = entryText.match(/^["“'‘]?([^"”'’]+)["”'’]?\s+means\s+(.+)$/i);
      if (quoted) {
        return {
          term: normalizeText(quoted[1]),
          definition: normalizeText(quoted[2]).replace(/;$/, ""),
        };
      }

      const means = entryText.match(/^(.+?)\s+means\s+(.+)$/i);
      if (means) {
        return {
          term: normalizeText(means[1]).replace(/^["“'‘]|["”'’]$/g, ""),
          definition: normalizeText(means[2]).replace(/;$/, ""),
        };
      }

      return null;
    })
    .filter((definition) => definition?.term && definition?.definition);
}

function buildRecital(recitalNumber, text, html) {
  const recitalText = normalizeText(text);
  return {
    recital_number: String(recitalNumber),
    recital_text: recitalText,
    recital_html: html || `<p>${escapeHtml(recitalText)}</p>`,
  };
}

function parseRecitals(paragraphs, articleStartIndex) {
  const recitals = [];
  let current = null;

  for (let index = 0; index < articleStartIndex; index += 1) {
    const paragraph = paragraphs[index];
    const match = paragraph.match(/^\((\d+)\)\s*(.*)$/);
    if (match) {
      if (current) recitals.push(current);
      current = {
        recital_number: match[1],
        chunks: [normalizeText(match[2])],
      };
      continue;
    }

    if (!current) continue;
    if (!paragraph) continue;
    current.chunks.push(normalizeText(paragraph));
  }

  if (current) recitals.push(current);

  return recitals.map((recital) => {
    const recitalText = normalizeText(recital.chunks.join(" "));
    return {
      recital_number: recital.recital_number,
      recital_text: recitalText,
      recital_html: `<p>${escapeHtml(recitalText)}</p>`,
    };
  });
}

function parseArticles(paragraphs) {
  const articles = [];
  let currentArticle = null;
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };

  const finalizeArticle = () => {
    if (!currentArticle) return;
    articles.push({
      ...currentArticle,
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = normalizeText(paragraphs[index]);
    if (!paragraph) continue;

    const divisionMarker = parseDivisionMarker(paragraph);
    if (divisionMarker) {
      let nextTitle = divisionMarker.title;
      if (!nextTitle && isLikelyDivisionTitle(paragraphs[index + 1])) {
        nextTitle = normalizeText(paragraphs[index + 1]);
        index += 1;
      }

      if (divisionMarker.kind === "section") {
        currentSection = {
          number: divisionMarker.number,
          title: nextTitle,
        };
      } else {
        currentChapter = {
          number: divisionMarker.number,
          title: nextTitle,
        };
        currentSection = { number: "", title: "" };
      }
      continue;
    }

    if (isArticleHeading(paragraph)) {
      finalizeArticle();
      const articleNumberMatch = paragraph.match(/^Article\s+(\d+[A-Za-z]*)$/i);
      currentArticle = {
        article_number: articleNumberMatch ? articleNumberMatch[1] : String(articles.length + 1),
        article_title: "",
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
      };
      continue;
    }

    if (!currentArticle) continue;

    if (!currentArticle.article_title && isLikelyArticleTitle(paragraph) && !isLikelyDivisionTitle(paragraph)) {
      currentArticle.article_title = paragraph;
      continue;
    }

    currentArticle.bodyParagraphs.push(paragraph);
  }

  finalizeArticle();
  return articles;
}

function parseLegacyXhtmlToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const metaTitle = document.querySelector('meta[name="WT.z_docTitle"]')?.getAttribute("content")
    || document.querySelector('meta[name="DC.description"]')?.getAttribute("content");

  const titleParagraphs = Array.from(document.querySelectorAll("p.doc-ti"))
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean);
  const fallbackTitle = titleParagraphs.slice(0, 3).join(" ");
  const title = normalizeText(metaTitle || fallbackTitle);

  const blocks = Array.from(document.querySelectorAll("p, table"))
    .map((element) => ({
      tagName: element.tagName,
      classes: new Set(Array.from(element.classList || [])),
      text: normalizeText(element.textContent),
      html: element.outerHTML,
    }))
    .filter((block) => block.text);

  const recitals = [];
  const articles = [];
  const annexes = [];
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let currentArticle = null;
  let currentAnnex = null;
  let recitalCounter = 1;

  const finalizeArticle = () => {
    if (!currentArticle) return;
    const articleHtmlParts = [];
    if (currentArticle.article_title) {
      articleHtmlParts.push(`<p class="oj-sti-art">${escapeHtml(currentArticle.article_title)}</p>`);
    }
    articleHtmlParts.push(...currentArticle.bodyHtmlBlocks);
    articles.push({
      article_number: currentArticle.article_number,
      article_title: currentArticle.article_title,
      division: currentArticle.division,
      article_html: injectCrossRefLinks(articleHtmlParts.join(""), langConfig),
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  const finalizeAnnex = () => {
    if (!currentAnnex) return;
    annexes.push({
      annex_id: currentAnnex.annex_id,
      annex_title: currentAnnex.annex_title,
      annex_html: injectCrossRefLinks(currentAnnex.htmlBlocks.join(""), langConfig),
    });
    currentAnnex = null;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const text = block.text;
    if (!text) continue;

    const isArticleStart = block.classes.has("ti-art") || isArticleHeading(text);
    if (isArticleStart) {
      finalizeAnnex();
      finalizeArticle();

      const articleNumberMatch = text.match(/Article\s+(\d+[A-Za-z]*)/i);
      currentArticle = {
        article_number: articleNumberMatch ? articleNumberMatch[1] : String(articles.length + 1),
        article_title: "",
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
        bodyHtmlBlocks: [],
      };
      continue;
    }

    const isAnnexStart = block.classes.has("doc-ti") && isAnnexHeading(text);
    if (isAnnexStart) {
      finalizeArticle();
      finalizeAnnex();

      let annexTitle = text;
      const nextBlock = blocks[index + 1];
      if (
        nextBlock &&
        nextBlock.tagName === "P" &&
        nextBlock.classes.has("doc-ti") &&
        !isAnnexHeading(nextBlock.text) &&
        !isArticleHeading(nextBlock.text)
      ) {
        annexTitle = `${text} — ${nextBlock.text}`;
        index += 1;
      }

      const annexMatch = text.match(/^ANNEX\s*([IVXLC]+|\d+)?/i);
      currentAnnex = {
        annex_id: normalizeText(annexMatch?.[1] || "") || annexTitle,
        annex_title: annexTitle,
        htmlBlocks: [],
      };
      continue;
    }

    const divisionMarker = parseDivisionMarker(text);
    if (divisionMarker) {
      let nextTitle = divisionMarker.title;
      const nextBlock = blocks[index + 1];
      if (
        !nextTitle &&
        nextBlock &&
        nextBlock.tagName === "P" &&
        isLikelyDivisionTitle(nextBlock.text)
      ) {
        nextTitle = nextBlock.text;
        index += 1;
      }

      if (divisionMarker.kind === "section") {
        currentSection = { number: divisionMarker.number, title: nextTitle };
      } else {
        currentChapter = { number: divisionMarker.number, title: nextTitle };
        currentSection = { number: "", title: "" };
      }
      continue;
    }

    if (currentAnnex) {
      currentAnnex.htmlBlocks.push(block.html);
      continue;
    }

    if (currentArticle) {
      if (
        !currentArticle.article_title &&
        block.tagName === "P" &&
        !block.classes.has("doc-ti") &&
        isLikelyArticleTitle(text) &&
        !isLikelyDivisionTitle(text)
      ) {
        currentArticle.article_title = text;
        continue;
      }

      currentArticle.bodyParagraphs.push(text);
      currentArticle.bodyHtmlBlocks.push(block.html);
      continue;
    }

    if (block.tagName !== "P") continue;
    if (block.classes.has("doc-ti")) continue;
    if (/^Whereas:?$/i.test(text)) continue;
    if (isLikelyDivisionTitle(text) || parseDivisionMarker(text)) continue;

    const recitalMatch = text.match(/^\((\d+)\)\s*(.*)$/);
    if (recitalMatch) {
      recitals.push(buildRecital(recitalMatch[1], recitalMatch[2], `<p>${escapeHtml(normalizeText(recitalMatch[2]))}</p>`));
      recitalCounter = Number.parseInt(recitalMatch[1], 10) + 1;
      continue;
    }

    if (block.classes.has("normal") || block.classes.has("note")) {
      recitals.push(buildRecital(recitalCounter, text, block.html));
      recitalCounter += 1;
    }
  }

  finalizeArticle();
  finalizeAnnex();

  const definitions = articles.flatMap((article) => parseDefinitions(article));

  return {
    title,
    articles: articles.map(({ bodyParagraphs, ...article }) => article),
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

// Commission / preparatory documents (proposals, communications) are published
// in EUR-Lex using the LegisWrite "manifestation" markup rather than the OJ
// `oj-*` classes. Articles are `<p class="Titrearticle">`, recitals are
// `<p class="li ManualConsidrant">`, divisions are `<p class="SectionTitle">`,
// and annexes start with `<p class="Annexetitre">`.
function parseLegisWriteToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const getText = (element) => normalizeText(element?.textContent);
  const hasClass = (element, name) => element.classList && element.classList.contains(name);

  const titleParts = ["Statut", "Typedudocument", "Titreobjet"]
    .map((cls) => getText(document.querySelector(`p.${cls}`)))
    .filter(Boolean);
  const title = normalizeText(titleParts.join(" "));

  const recitals = [];
  for (const element of document.querySelectorAll("p.li.ManualConsidrant")) {
    const numText = getText(element.querySelector(".num"));
    const numberMatch = numText.match(/(\d+)/);
    const recital_number = numberMatch ? numberMatch[1] : String(recitals.length + 1);
    const text = stripLeadingMarker(getText(element), /^\(\d+\)\s*/);
    recitals.push(buildRecital(recital_number, text, `<p>${escapeHtml(text)}</p>`));
  }

  const articles = [];
  const annexes = [];
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let pendingDivision = null;
  let currentArticle = null;
  let currentAnnex = null;
  let inEnactingTerms = false;

  const finalizeArticle = () => {
    if (!currentArticle) return;
    const html = paragraphsToHtml(currentArticle.bodyParagraphs, { title: currentArticle.article_title });
    articles.push({
      article_number: currentArticle.article_number,
      article_title: currentArticle.article_title,
      division: currentArticle.division,
      article_html: injectCrossRefLinks(html, langConfig),
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  const finalizeAnnex = () => {
    if (!currentAnnex) return;
    annexes.push({
      annex_id: currentAnnex.annex_id,
      annex_title: currentAnnex.annex_title,
      annex_html: injectCrossRefLinks(paragraphsToHtml(currentAnnex.bodyParagraphs), langConfig),
    });
    currentAnnex = null;
  };

  for (const element of document.body.querySelectorAll("p")) {
    const text = getText(element);
    if (!text) continue;

    if (hasClass(element, "Formuledadoption")) {
      inEnactingTerms = true;
      continue;
    }

    if (hasClass(element, "Annexetitre")) {
      finalizeArticle();
      finalizeAnnex();
      inEnactingTerms = true;
      pendingDivision = null;
      const annexMatch = text.match(/^ANNEX\s*([IVXLCDM]+|\d+)?/i);
      currentAnnex = {
        annex_id: normalizeText(annexMatch?.[1] || "") || text,
        annex_title: text,
        bodyParagraphs: [],
      };
      continue;
    }

    if (hasClass(element, "Titrearticle")) {
      finalizeAnnex();
      finalizeArticle();
      inEnactingTerms = true;
      pendingDivision = null;
      const numberMatch = text.match(/^Article\s+(\d+[A-Za-z]*)\s*(.*)$/i);
      currentArticle = {
        article_number: numberMatch ? numberMatch[1] : String(articles.length + 1),
        article_title: numberMatch ? normalizeText(numberMatch[2]) : "",
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
      };
      continue;
    }

    if (hasClass(element, "SectionTitle")) {
      if (!inEnactingTerms) continue;
      const divisionMarker = parseDivisionMarker(text);
      if (divisionMarker) {
        finalizeArticle();
        if (divisionMarker.kind === "section") {
          currentSection = { number: divisionMarker.number, title: divisionMarker.title };
          pendingDivision = currentSection;
        } else {
          currentChapter = { number: divisionMarker.number, title: divisionMarker.title };
          currentSection = { number: "", title: "" };
          pendingDivision = currentChapter;
        }
      } else if (pendingDivision && !pendingDivision.title) {
        pendingDivision.title = text;
        pendingDivision = null;
      }
      continue;
    }

    if (currentAnnex) {
      currentAnnex.bodyParagraphs.push(text);
      continue;
    }

    if (currentArticle) {
      currentArticle.bodyParagraphs.push(text);
    }
  }

  finalizeArticle();
  finalizeAnnex();

  const definitions = articles.flatMap((article) => parseDefinitions(article));

  recitals.sort((left, right) => {
    const leftNum = Number.parseInt(String(left.recital_number).replace(/\D+/g, ""), 10) || 0;
    const rightNum = Number.parseInt(String(right.recital_number).replace(/\D+/g, ""), 10) || 0;
    return leftNum - rightNum;
  });

  return {
    title,
    articles: articles.map(({ bodyParagraphs, ...article }) => article),
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

async function loadHelpers() {
  if (!helperPromise) {
    helperPromise = (async () => {
      if (typeof global.DOMParser === "undefined") {
        const shimDom = new JSDOM("", { url: "https://eur-lex.europa.eu/" });
        global.DOMParser = shimDom.window.DOMParser;
        global.Node = shimDom.window.Node;
        global.NodeFilter = shimDom.window.NodeFilter;
      }

      const [parserMod, langMod] = await Promise.all([
        import("./formex-parser/fmxParser.mjs"),
        import("./formex-parser/languages.mjs"),
      ]);

      return {
        injectCrossRefLinks: parserMod.injectCrossRefLinks,
        getLangConfig: langMod.getLangConfig,
      };
    })();
  }

  return helperPromise;
}

async function parseEurlexHtmlToCombined(htmlText, lang = "ENG") {
  const dom = new JSDOM(htmlText, { url: "https://eur-lex.europa.eu/" });
  const document = dom.window.document;
  const langCode = normalizeText(document.documentElement.getAttribute("lang") || LANG_3_TO_2[lang] || "EN").toUpperCase();
  const { injectCrossRefLinks, getLangConfig } = await loadHelpers();
  const langConfig = getLangConfig(langCode);

  const hasStructuredLayout = Boolean(
    document.querySelector(".eli-subdivision, .oj-ti-art, .title-article-norm, .oj-ti-annex, .title-annex-norm")
  );
  if (hasStructuredLayout) {
    const parsedStructured = parseStructuredHtmlToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedStructured.articles.length || parsedStructured.recitals.length || parsedStructured.annexes.length) {
      return parsedStructured;
    }
  }

  const hasLegacyXhtmlLayout = Boolean(
    document.querySelector("p.ti-art") && document.querySelector("p.normal, p.doc-ti")
  );
  if (hasLegacyXhtmlLayout) {
    const parsedLegacyXhtml = parseLegacyXhtmlToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedLegacyXhtml.articles.length || parsedLegacyXhtml.recitals.length || parsedLegacyXhtml.annexes.length) {
      return parsedLegacyXhtml;
    }
  }

  const hasLegisWriteLayout = Boolean(
    document.querySelector("p.Titrearticle, p.li.ManualConsidrant")
  );
  if (hasLegisWriteLayout) {
    const parsedLegisWrite = parseLegisWriteToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedLegisWrite.articles.length || parsedLegisWrite.recitals.length || parsedLegisWrite.annexes.length) {
      return parsedLegisWrite;
    }
  }

  let paragraphs = [];

  const fragmentMatch = String(htmlText || "").match(/<TXT_TE>([\s\S]*?)<\/TXT_TE>/i);
  if (fragmentMatch) {
    const fragment = JSDOM.fragment(fragmentMatch[1]);
    paragraphs = Array.from(fragment.querySelectorAll("p"))
      .map((paragraph) => normalizeText(paragraph.textContent))
      .filter(Boolean);
  }

  // Fallback: some legacy pages have an empty <TXT_TE/> or none at all —
  // collect all <p> text from the full document body instead.
  if (paragraphs.length === 0) {
    paragraphs = Array.from(document.body.querySelectorAll("p"))
      .map((paragraph) => normalizeText(paragraph.textContent))
      .filter(Boolean);
  }

  if (paragraphs.length === 0) {
    throw new ClientError("EUR-Lex HTML body is empty", 404, "law_not_found");
  }

  const metaTitle = document.querySelector('meta[name="WT.z_docTitle"]')?.getAttribute("content")
    || document.querySelector('meta[name="DC.description"]')?.getAttribute("content")
    || paragraphs.slice(0, 3).join(" ");
  const title = normalizeText(metaTitle);

  const whereasIndex = paragraphs.findIndex((paragraph) => /^Whereas:?$/i.test(paragraph));
  const articleStartIndex = paragraphs.findIndex((paragraph) => isArticleHeading(paragraph));
  const recitalParagraphs = whereasIndex >= 0 && articleStartIndex > whereasIndex
    ? paragraphs.slice(whereasIndex + 1, articleStartIndex)
    : [];
  const recitals = parseRecitals(recitalParagraphs, recitalParagraphs.length);

  const articles = parseArticles(paragraphs.slice(articleStartIndex >= 0 ? articleStartIndex : paragraphs.length))
    .map((article) => {
      const html = paragraphsToHtml(article.bodyParagraphs, { title: article.article_title });
      return {
        article_number: article.article_number,
        article_title: article.article_title,
        division: article.division || {
          chapter: { number: "", title: "" },
          section: null,
        },
        article_html: injectCrossRefLinks(html, langConfig),
        bodyParagraphs: article.bodyParagraphs,
      };
    });

  const definitions = articles.flatMap((article) => parseDefinitions(article));

  return {
    title,
    articles: articles.map(({ bodyParagraphs, ...article }) => article),
    recitals,
    annexes: [],
    definitions,
    langCode,
    crossReferences: {},
  };
}

async function loadPlaywrightModule(modulePath = null) {
  const candidates = [
    modulePath,
    process.env.LEGALVIZ_PLAYWRIGHT_MODULE_PATH,
    "playwright",
    "playwright-core",
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return requireFromHere(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error(
    `Playwright module is not available. Tried: ${candidates.join(", ")}`
  );
  error.cause = lastError;
  throw error;
}

function isRetriablePlaywrightError(error) {
  const message = String(error?.message || error || "");
  return /Target page, context or browser has been closed/i.test(message)
    || /Browser has been closed/i.test(message)
    || /Page crashed/i.test(message)
    || /Target closed/i.test(message);
}

function resetBrowserIdleTimer() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    closeSharedPlaywrightBrowser();
  }, DEFAULT_BROWSER_IDLE_MS);
}

async function closeSharedPlaywrightBrowser() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  sharedPlaywrightPage = null;
  if (!sharedPlaywrightBrowser) return;
  try {
    await sharedPlaywrightBrowser.close();
  } catch {}
  sharedPlaywrightBrowser = null;
  sharedPlaywrightBrowserKey = null;
  console.log("[Playwright] Browser closed");
}

async function getSharedPlaywrightBrowser(playwright, { playwrightBrowsersPath = null, headless = true } = {}) {
  const key = JSON.stringify({
    browserType: "chromium",
    playwrightBrowsersPath: playwrightBrowsersPath || "",
    headless: Boolean(headless),
  });

  if (sharedPlaywrightBrowser && sharedPlaywrightBrowserKey === key && sharedPlaywrightBrowser.isConnected()) {
    resetBrowserIdleTimer();
    return sharedPlaywrightBrowser;
  }

  await closeSharedPlaywrightBrowser();
  console.log("[Playwright] Launching browser...");
  sharedPlaywrightBrowser = await playwright.chromium.launch({ headless });
  sharedPlaywrightBrowserKey = key;
  resetBrowserIdleTimer();
  return sharedPlaywrightBrowser;
}

async function getSharedPlaywrightPage(playwright, options = {}) {
  const browser = await getSharedPlaywrightBrowser(playwright, options);
  if (sharedPlaywrightPage && !sharedPlaywrightPage.isClosed()) {
    return sharedPlaywrightPage;
  }
  sharedPlaywrightPage = await browser.newPage();
  return sharedPlaywrightPage;
}

async function fetchEurlexHtmlWithPlaywright({
  url,
  timeoutMs,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  maxRetries = DEFAULT_PLAYWRIGHT_RETRIES,
  headless = true,
  closeBrowserAfterFetch = false,
}) {
  const playwright = await loadPlaywrightModule(playwrightModulePath);
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (playwrightBrowsersPath) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const page = await getSharedPlaywrightPage(playwright, { playwrightBrowsersPath, headless });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(1_000);
        const html = await page.content();
        if (closeBrowserAfterFetch) {
          await closeSharedPlaywrightBrowser();
        }
        return html;
      } catch (error) {
        if (isRetriablePlaywrightError(error)) {
          await closeSharedPlaywrightBrowser();
        }
        if (!isRetriablePlaywrightError(error) || attempt >= maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, attempt * 1_000)));
      }
    }
  } finally {
    if (playwrightBrowsersPath) {
      if (previousBrowsersPath == null) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
    }
  }
}

async function fetchEurlexHtmlLaw({
  celex,
  lang = "ENG",
  eurlexBase,
  timeoutMs = 30_000,
  usePlaywright = false,
  usePlaywrightOnChallenge = false,
  closeBrowserAfterFetch = true,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  playwrightHeadless = true,
  fetchImpl = fetch,
  fetchWithPlaywrightImpl = fetchEurlexHtmlWithPlaywright,
}) {
  const requestedLang = String(lang || "ENG").toUpperCase();
  const servedLang = "ENG";
  const languageCode = "EN";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${eurlexBase}/legal-content/${languageCode}/TXT/HTML/?uri=CELEX:${encodeURIComponent(celex)}`;
    let htmlText = null;
    let response = null;

    if (!usePlaywright) {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      });
    }

    if (usePlaywright) {
      htmlText = await fetchWithPlaywrightImpl({
        url,
        timeoutMs,
        playwrightModulePath,
        playwrightBrowsersPath,
        headless: playwrightHeadless,
        closeBrowserAfterFetch,
      });
    } else if (response.status === 202 && String(response.headers.get("x-amzn-waf-action") || "").toLowerCase() === "challenge") {
      if (usePlaywrightOnChallenge) {
        htmlText = await fetchWithPlaywrightImpl({
          url,
          timeoutMs,
          playwrightModulePath,
          playwrightBrowsersPath,
          headless: playwrightHeadless,
          closeBrowserAfterFetch,
        });
      } else {
        throw new ClientError(
          `EUR-Lex HTML access is currently being challenged for ${celex}`,
          503,
          "eurlex_html_challenged",
          {
            celex,
            requestedLang,
            servedLang,
            upstreamStatus: response.status,
          }
        );
      }
    } else {
      if (response.status === 404) {
        throw new ClientError(`No EUR-Lex HTML law found for ${celex}`, 404, "law_not_found");
      }
      if (!response.ok) {
        throw new ClientError(`EUR-Lex HTML fetch failed with HTTP ${response.status}`, response.status, "eurlex_html_unavailable");
      }
      htmlText = await response.text();
    }
    return {
      celex,
      lang: servedLang,
      requestedLang,
      servedLang,
      source: "eurlex-html",
      rawHtml: htmlText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAndParseEurlexHtmlLaw({
  celex,
  lang = "ENG",
  eurlexBase,
  timeoutMs = 30_000,
  includeRawHtml = false,
  usePlaywright = false,
  usePlaywrightOnChallenge = false,
  closeBrowserAfterFetch = true,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  playwrightHeadless = true,
  fetchImpl = fetch,
  fetchWithPlaywrightImpl = fetchEurlexHtmlWithPlaywright,
}) {
  const fetched = await fetchEurlexHtmlLaw({
    celex,
    lang,
    eurlexBase,
    timeoutMs,
    usePlaywright,
    usePlaywrightOnChallenge,
    closeBrowserAfterFetch,
    playwrightModulePath,
    playwrightBrowsersPath,
    playwrightHeadless,
    fetchImpl,
    fetchWithPlaywrightImpl,
  });
  const parsed = await parseEurlexHtmlToCombined(fetched.rawHtml, fetched.servedLang);
  const base = includeRawHtml ? fetched : (() => {
    const { rawHtml, ...withoutRawHtml } = fetched;
    return withoutRawHtml;
  })();
  return {
    ...base,
    format: "combined-v1",
    ...parsed,
  };
}

module.exports = {
  closeSharedPlaywrightBrowser,
  fetchEurlexHtmlLaw,
  fetchEurlexHtmlWithPlaywright,
  fetchAndParseEurlexHtmlLaw,
  getSharedPlaywrightBrowser,
  getSharedPlaywrightPage,
  isRetriablePlaywrightError,
  loadPlaywrightModule,
  parseEurlexHtmlToCombined,
};
