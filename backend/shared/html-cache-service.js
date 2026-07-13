const fs = require('fs');
const path = require('path');
const { gzip, gunzip } = require('zlib');
const { promisify } = require('util');

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * On-disk cache for raw EUR-Lex HTML law pages.
 *
 * Stores gzip-compressed HTML alongside FMX files in the same cache directory.
 * HTML is parsed on each request so that parser improvements take effect
 * without re-fetching from EUR-Lex.
 *
 * Each service only evicts its own file type:
 *   - FMX: *.xml, *.zip, *.combined.xml
 *   - HTML: *.html.gz
 *
 * File naming: {CELEX}_{LANG}.html.gz
 */
function createHtmlCacheService({ CACHE_DIR, STORAGE_LIMIT_MB }) {
  function cacheFileName(celex, lang) {
    return `${celex}_${lang}.html.gz`;
  }

  function cachePath(celex, lang) {
    return path.join(CACHE_DIR, cacheFileName(celex, lang));
  }

  function getCacheFiles() {
    try {
      return fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.endsWith('.html.gz'))
        .map((filename) => {
          const stat = fs.statSync(path.join(CACHE_DIR, filename));
          return { filename, path: path.join(CACHE_DIR, filename), size: stat.size, mtime: stat.mtime };
        })
        .sort((a, b) => a.mtime - b.mtime); // oldest first
    } catch {
      return [];
    }
  }

  function getCacheSizeMB() {
    return getCacheFiles().reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  }

  function evictOldestIfNeeded(requiredMB) {
    const files = getCacheFiles();
    const currentMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    if (currentMB + requiredMB <= STORAGE_LIMIT_MB) {
      return { evicted: 0 };
    }
    let freedMB = 0;
    let evicted = 0;
    const targetMB = currentMB + requiredMB - STORAGE_LIMIT_MB;

    for (const file of files) {
      if (freedMB >= targetMB) break;
      fs.unlinkSync(file.path);
      freedMB += file.size / (1024 * 1024);
      evicted += 1;
      console.log(`[HtmlCache] Evicted ${file.filename} (freed ${(file.size / 1024).toFixed(0)} KB)`);
    }

    return { evicted, freedMB: freedMB.toFixed(2) };
  }

  /**
   * Returns the cached raw HTML string, or null on miss.
   */
  async function get(celex, lang) {
    const filePath = cachePath(celex, lang);
    try {
      const compressed = fs.readFileSync(filePath);
      const html = (await gunzipAsync(compressed)).toString('utf8');
      // Touch mtime so LRU eviction treats this as recently used
      const now = new Date();
      fs.utimesSync(filePath, now, now);
      console.log(`[HtmlCache] Hit: ${cacheFileName(celex, lang)}`);
      return html;
    } catch {
      return null;
    }
  }

  /**
   * Stores raw HTML to disk (gzip-compressed).
   */
  async function put(celex, lang, html) {
    const compressed = await gzipAsync(Buffer.from(html, 'utf8'));
    const requiredMB = compressed.length / (1024 * 1024);
    evictOldestIfNeeded(requiredMB);

    const filePath = cachePath(celex, lang);
    fs.writeFileSync(filePath, compressed);
    console.log(`[HtmlCache] Stored: ${cacheFileName(celex, lang)} (${(compressed.length / 1024).toFixed(1)} KB)`);
  }

  function remove(celex, lang) {
    const filePath = cachePath(celex, lang);
    try {
      fs.unlinkSync(filePath);
      console.log(`[HtmlCache] Removed: ${cacheFileName(celex, lang)}`);
      return true;
    } catch {
      return false;
    }
  }

  return { get, put, remove, getCacheSizeMB, evictOldestIfNeeded };
}

module.exports = { createHtmlCacheService };
