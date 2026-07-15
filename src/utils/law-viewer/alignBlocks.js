// Display-only block alignment for parallel-language reading.
//
// The Formex parser emits one law article/recital/annex as a stable sequence of
// top-level block elements (paragraphs, numbered groups, tables, lists). For the
// same item in two languages the block *structure* matches, so pairing the two
// HTML strings block-by-block by index yields aligned rows the reader can scan
// across. This never touches the shared parser and invents no HTML sources — it
// only re-slices already-produced, already-sanitised HTML strings.

/**
 * Split an HTML string into an array of its top-level block outerHTML strings.
 * Whitespace-only text nodes between blocks are ignored; a meaningful stray text
 * node is kept as its own block so index parity with the other language holds.
 */
function splitTopLevelBlocks(html) {
  const source = String(html || "").trim();
  if (!source) return [];

  // No DOM available (e.g. build-time prerender) — treat the whole thing as one
  // block rather than throwing; callers fall back to the two-pane layout.
  if (typeof DOMParser === "undefined") return [source];

  const doc = new DOMParser().parseFromString(
    `<div id="__align_root">${source}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__align_root");
  if (!root) return [source];

  const blocks = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 1) {
      blocks.push(node.outerHTML);
    } else if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text) blocks.push(node.textContent);
    }
  }
  return blocks;
}

/**
 * Pair two parser-produced HTML strings for the same item in two languages into
 * aligned rows `[{ a, b }]`, one row per block, paired by index. When the block
 * counts differ, the common prefix is paired and the remaining blocks become
 * one-sided rows (the missing side is `null`). Never throws.
 *
 * @param {string} htmlA - primary-language HTML
 * @param {string} htmlB - secondary-language HTML
 * @returns {Array<{a: string|null, b: string|null}>}
 */
export function alignHtmlBlocks(htmlA, htmlB) {
  const blocksA = splitTopLevelBlocks(htmlA);
  const blocksB = splitTopLevelBlocks(htmlB);
  const rowCount = Math.max(blocksA.length, blocksB.length);

  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    rows.push({
      a: i < blocksA.length ? blocksA[i] : null,
      b: i < blocksB.length ? blocksB[i] : null,
    });
  }
  return rows;
}
