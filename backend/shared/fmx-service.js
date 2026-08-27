const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ClientError } = require('./api-utils');

/** Trailing `.<LANG>.fmx4` on a Cellar manifestation URI, any 3-letter language. */
const FMX4_ANY_LANG = /\.[A-Z]{3}\.fmx4$/;
const FMX_PATH_MEMO_FILE = 'fmx-paths-v1.json';
const CACHE_PROBE_BYTES = 64 * 1024;
// Re-probe twice a day: normal traffic stays off Cellar for hours, while a
// newly published corrigendum is picked up without leaving stale legal text
// pinned for the life of the cache directory.
const FMX_PATH_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
// Writers normally finish in seconds; an hour leaves ample room for a slow
// download while still cleaning up temp files left by crashed processes.
const FMX_TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

function writeFileAtomically(filePath, data, encoding) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, data, encoding);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The write may have failed before creating the temporary file.
    }
    throw error;
  }
}

/** True when the system `unzip` binary is available. */
const HAS_SYSTEM_UNZIP = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function createFmxService({
  CELLAR_BASE,
  FMX_DIR,
  STORAGE_LIMIT_MB,
  TIMEOUT_MS,
}) {
  const cacheRoot = path.resolve(FMX_DIR);
  const servePathMemoPath = path.join(FMX_DIR, FMX_PATH_MEMO_FILE);

  function isFmxTempFile(filename) {
    return /(?:\.xml|\.zip)\.\d+(?:\.\d+)?\.tmp$/.test(filename)
      || (filename.startsWith(`${FMX_PATH_MEMO_FILE}.`)
        && /^\d+(?:\.\d+)?\.tmp$/.test(filename.slice(FMX_PATH_MEMO_FILE.length + 1)));
  }

  function cleanupTempFiles() {
    try {
      const cutoff = Date.now() - FMX_TEMP_FILE_MAX_AGE_MS;
      for (const filename of fs.readdirSync(FMX_DIR).filter(isFmxTempFile)) {
        try {
          const tempPath = path.join(FMX_DIR, filename);
          if (fs.statSync(tempPath).mtimeMs >= cutoff) continue;
          fs.unlinkSync(tempPath);
        } catch {
          // A concurrent writer may have already renamed, removed, or replaced it.
        }
      }
    } catch {
      // The cache directory may not exist until the first download.
    }
  }

  function readFileEdges(filePath) {
    let fd;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) return null;

      fd = fs.openSync(filePath, 'r');
      const length = Math.min(CACHE_PROBE_BYTES, stat.size);
      const head = Buffer.alloc(length);
      const tail = Buffer.alloc(length);
      fs.readSync(fd, head, 0, length, 0);
      fs.readSync(fd, tail, 0, length, Math.max(0, stat.size - length));
      return { stat, head, tail };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Nothing useful can be done if a best-effort integrity probe cannot close.
        }
      }
    }
  }

  /**
   * Validate the cheap structural markers that an interrupted write cannot
   * leave behind. This deliberately probes only both ends of the file: the
   * full XML is parsed by the caller after prepareLawPayload returns, while a
   * zero-byte or cut-off cache must never be mistaken for a hit here.
   */
  function isValidCachedFile(filePath, existingEdges = null) {
    const edges = existingEdges || readFileEdges(filePath);
    if (!edges) return false;

    if (filePath.endsWith('.zip')) {
      return [
        Buffer.from([0x50, 0x4b, 0x05, 0x06]), // end of central directory
        Buffer.from([0x50, 0x4b, 0x06, 0x06]), // ZIP64 end of central directory
      ].some((signature) => edges.tail.includes(signature));
    }

    const head = edges.head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    const tail = edges.tail.toString('utf8').trimEnd();
    if (!head.startsWith('<') || !tail.endsWith('>')) return false;

    if (filePath.endsWith('.combined.xml')) {
      return /<COMBINED\.FMX(?:\s[^>]*)?>/.test(head)
        && /<\/COMBINED\.FMX>\s*$/.test(tail);
    }

    const rootMatch = head.match(/<(?![!?/])([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>/);
    if (!rootMatch) return false;
    if (/\/\s*>$/.test(rootMatch[0])) return true;
    const rootName = rootMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`</${rootName}\\s*>\\s*$`).test(tail);
  }

  function loadServePathMemo() {
    try {
      const parsed = JSON.parse(fs.readFileSync(servePathMemoPath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        return {};
      }
      return parsed.entries;
    } catch {
      return {};
    }
  }

  let servePathMemo;

  function persistServePathMemo() {
    try {
      fs.mkdirSync(FMX_DIR, { recursive: true });
      writeFileAtomically(
        servePathMemoPath,
        JSON.stringify({ version: 1, entries: servePathMemo }, null, 2),
        'utf8'
      );
    } catch {
      // The on-disk memo is an optimization; a failed persistence must not
      // make an otherwise valid download fail.
    }
  }

  function memoKey(celex, lang) {
    return `${celex}\u0000${lang}`;
  }

  function resolveMemoPath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
    const candidate = path.resolve(FMX_DIR, relativePath);
    const relative = path.relative(cacheRoot, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return candidate;
  }

  function getMemoizedPayload(celex, lang) {
    const key = memoKey(celex, lang);
    const entry = servePathMemo[key];
    const now = Date.now();
    const isMemoEntry = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    const hasFreshMetadata = isMemoEntry
      && typeof entry.fmx4Uri === 'string'
      && entry.fmx4Uri.length > 0
      && Number.isFinite(entry.writtenAt)
      && entry.writtenAt <= now
      && now - entry.writtenAt <= FMX_PATH_MEMO_TTL_MS;
    const relativePath = typeof entry === 'string' ? entry : entry?.path;
    const servePath = resolveMemoPath(relativePath);
    const hasWrongIdentity = isMemoEntry
      && (entry.celex !== celex || entry.lang !== lang);
    const edges = servePath && readFileEdges(servePath);
    if (!hasFreshMetadata
      || hasWrongIdentity
      || !servePath
      || !edges
      || !isValidCachedFile(servePath, edges)
      || (isMemoEntry && entry.size !== edges.stat.size)) {
      if (Object.prototype.hasOwnProperty.call(servePathMemo, key)) {
        delete servePathMemo[key];
        persistServePathMemo();
      }
      return null;
    }

    return {
      type: entry?.type === 'zip' ? 'zip' : 'xml',
      files: [{ filename: path.basename(servePath), path: servePath, cached: true, size: edges.stat.size }],
      servePath,
    };
  }

  function rememberServePath(celex, lang, type, servePath, fmx4Uri) {
    const relativePath = path.relative(cacheRoot, path.resolve(servePath));
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;
    servePathMemo[memoKey(celex, lang)] = {
      celex,
      lang,
      path: relativePath,
      type,
      size: fs.statSync(servePath).size,
      fmx4Uri,
      writtenAt: Date.now(),
    };
    persistServePathMemo();
  }

  cleanupTempFiles();
  servePathMemo = loadServePathMemo();

  function getCacheSizeMB() {
    try {
      const files = fs.readdirSync(FMX_DIR).filter((filename) => filename.endsWith('.xml') || filename.endsWith('.zip'));
      let totalBytes = 0;
      for (const filename of files) {
        totalBytes += fs.statSync(path.join(FMX_DIR, filename)).size;
      }
      return totalBytes / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  function getCacheFiles() {
    try {
      return fs.readdirSync(FMX_DIR)
        .filter((filename) => filename.endsWith('.xml') || filename.endsWith('.zip'))
        .map((filename) => {
          const stat = fs.statSync(path.join(FMX_DIR, filename));
          return { filename, path: path.join(FMX_DIR, filename), size: stat.size, mtime: stat.mtime };
        })
        .sort((a, b) => a.mtime - b.mtime);
    } catch {
      return [];
    }
  }

  function evictOldestIfNeeded(requiredMB) {
    cleanupTempFiles();
    const currentMB = getCacheSizeMB();
    if (currentMB + requiredMB <= STORAGE_LIMIT_MB) {
      return { evicted: 0 };
    }

    const files = getCacheFiles();
    let freedMB = 0;
    let evicted = 0;
    const targetMB = currentMB + requiredMB - STORAGE_LIMIT_MB;

    for (const file of files) {
      if (freedMB >= targetMB) break;
      fs.unlinkSync(file.path);
      freedMB += file.size / (1024 * 1024);
      evicted += 1;
      console.log(`[Cache] Evicted ${file.filename} (freed ${(file.size / 1024).toFixed(0)} KB)`);
    }

    return { evicted, freedMB: freedMB.toFixed(2) };
  }

  async function fetchWithTimeout(url, options = {}) {
    // AbortSignal.timeout stays armed while the body is consumed, so the
    // deadline also covers the caller's response.text()/arrayBuffer() reads —
    // the previous cleared-setTimeout version stopped covering the request as
    // soon as headers arrived, letting a trickling body pin it indefinitely.
    return fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
  }

  async function getRdf(url) {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: '*/*', 'Accept-Language': 'eng' }
    });
    if (response.status === 404) throw new ClientError('Law not found in EUR-Lex Cellar', 404, 'celex_not_found');
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  }

  function extractUris(rdf) {
    return [...rdf.matchAll(/rdf:resource="([^"]+)"/g)].map((match) => match[1]);
  }

  /**
   * Locate the Formex manifestation for a CELEX, in the requested language.
   *
   * Match on the `.<LANG>.fmx4` suffix alone rather than on an allowlist of
   * manifestation id formats. Cellar mints those ids from several production
   * systems, and enumerating them silently loses acts: the previous pattern
   * accepted only `/oj/L_<9 digits>` (post-2016) and `/oj/JOL_<year>_<issue>_R_
   * <seq>`, so it missed the pre-2016 `…_R_<seq>_<part>` form (CRR, the VAT
   * Directive, Solvency II), the `/immc/planjo%3A<date>-<seq>` form used for
   * acts produced against a planned OJ slot (PSD2, MiFID II), and the
   * `/celex/…` and `/consolidation/…` forms. `search/search-build.js` already
   * matches this way, which is why the harvest saw acts the reader could not.
   *
   * A miss here is indistinguishable downstream from an act that genuinely has
   * no Formex — `resolveParsedLaw` reads the 404 as "no FMX" and falls back to
   * the EUR-Lex HTML parser — so narrowing this again degrades laws silently
   * rather than failing.
   */
  async function findFmx4Uri(celex, lang = 'ENG') {
    const rdf = await getRdf(`${CELLAR_BASE}/celex/${celex}`);
    const uris = extractUris(rdf);

    let fmx4 = uris.find((uri) => uri.endsWith(`.${lang}.fmx4`));

    if (!fmx4) {
      // Cellar lists one manifestation per available language; when the
      // requested one is absent, swap the language segment of any other.
      const anyLang = uris.find((uri) => FMX4_ANY_LANG.test(uri));
      if (anyLang) {
        fmx4 = anyLang.replace(FMX4_ANY_LANG, `.${lang}.fmx4`);
      }
    }

    if (!fmx4) throw new ClientError(`No Formex data available for this law in language ${lang}`, 404, 'fmx_not_found');
    return fmx4;
  }

  async function findDownloadUrls(fmx4Uri) {
    const rdf = await getRdf(fmx4Uri);
    const uris = extractUris(rdf);

    const zip = uris.find((uri) => uri.endsWith('.zip'));
    if (zip) return { type: 'zip', urls: [zip] };

    const allXmlFiles = uris.filter((uri) =>
      uri.match(/\.fmx4\.[^/]+\.xml$/) && !uri.endsWith('.doc.xml')
    );
    const seen = new Set();
    const xmlFiles = allXmlFiles.filter((uri) => {
      const suffix = uri.split('.fmx4.').pop();
      if (seen.has(suffix)) return false;
      seen.add(suffix);
      return true;
    });

    if (xmlFiles.length) return { type: 'xml', urls: xmlFiles };

    const docXmls = uris.filter((uri) => uri.endsWith('.doc.xml'));
    if (docXmls.length) return { type: 'xml', urls: docXmls };

    throw new ClientError('No downloadable Formex files found for this law', 404, 'fmx_not_found');
  }

  function combineZipToXml(zipPath) {
    const combinedPath = zipPath.replace(/\.zip$/, '.combined.xml');
    if (isValidCachedFile(combinedPath)) return combinedPath;

    if (HAS_SYSTEM_UNZIP) {
      return combineZipWithUnzip(zipPath, combinedPath);
    }

    // Fallback: adm-zip (npm package, works when system unzip is unavailable)
    let AdmZip;
    try {
      AdmZip = require('adm-zip');
    } catch {
      throw new Error(
        'ZIP extraction requires either the system "unzip" command or the "adm-zip" npm package. ' +
        'Install one of them: apt-get install unzip  OR  npm install adm-zip'
      );
    }
    return combineZipWithAdmZip(zipPath, combinedPath, AdmZip);
  }

  function combineZipWithUnzip(zipPath, combinedPath) {
    const unzipOpts = { maxBuffer: 50 * 1024 * 1024 };
    const listing = execFileSync('unzip', ['-Z1', zipPath], unzipOpts).toString('utf8');
    const entryNames = listing.split('\n').map((l) => l.trim()).filter(Boolean);

    const { docEntryName, isOldFormat } = findManifestEntry(entryNames);
    const manifest = execFileSync('unzip', ['-p', zipPath, docEntryName], unzipOpts).toString('utf8');
    const physRefs = resolvePhysicalRefs(manifest, entryNames, docEntryName, isOldFormat);

    const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<COMBINED.FMX>'];
    for (const ref of physRefs) {
      let xml = execFileSync('unzip', ['-p', zipPath, ref], unzipOpts).toString('utf8');
      xml = xml.replace(/<\?xml[^?]*\?>/, '').trim();
      parts.push(xml);
    }
    parts.push('</COMBINED.FMX>');

    writeFileAtomically(combinedPath, parts.join('\n'), 'utf8');
    if (!isValidCachedFile(combinedPath)) {
      throw new Error(`Combined ZIP output failed integrity check: ${combinedPath}`);
    }
    console.log(`[ZIP] Combined ${physRefs.length} files from ${path.basename(zipPath)} -> ${path.basename(combinedPath)}`);
    return combinedPath;
  }

  function combineZipWithAdmZip(zipPath, combinedPath, AdmZip) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const entryNames = entries.map((entry) => entry.entryName);

    const { docEntryName, isOldFormat } = findManifestEntry(entryNames);
    const docEntry = entries.find((e) => e.entryName === docEntryName);
    const manifest = docEntry.getData().toString('utf8');
    const physRefs = resolvePhysicalRefs(manifest, entryNames, docEntryName, isOldFormat);

    const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<COMBINED.FMX>'];
    for (const ref of physRefs) {
      const entry = zip.getEntry(ref);
      let xml = entry.getData().toString('utf8');
      xml = xml.replace(/<\?xml[^?]*\?>/, '').trim();
      parts.push(xml);
    }
    parts.push('</COMBINED.FMX>');

    writeFileAtomically(combinedPath, parts.join('\n'), 'utf8');
    if (!isValidCachedFile(combinedPath)) {
      throw new Error(`Combined ZIP output failed integrity check: ${combinedPath}`);
    }
    console.log(`[ZIP] Combined ${physRefs.length} files from ${path.basename(zipPath)} -> ${path.basename(combinedPath)}`);
    return combinedPath;
  }

  function findManifestEntry(entryNames) {
    let docEntryName = entryNames.find((name) => name.endsWith('.doc.fmx.xml'));
    const isOldFormat = !docEntryName;
    if (!docEntryName) {
      docEntryName = entryNames.find((name) => name.endsWith('.doc.xml'));
    }
    if (!docEntryName) {
      throw new Error('No *.doc.fmx.xml manifest found in ZIP');
    }
    return { docEntryName, isOldFormat };
  }

  function resolvePhysicalRefs(manifest, entryNames, docEntryName, isOldFormat) {
    const refPattern = /FILE="([^"]+)"/g;
    const physRefs = [];
    let match;
    while ((match = refPattern.exec(manifest)) !== null) {
      const ref = match[1];
      const isDataFile = isOldFormat
        ? ref.endsWith('.xml') && !ref.endsWith('.doc.xml')
        : ref.endsWith('.fmx.xml');
      if (isDataFile && ref !== docEntryName && entryNames.includes(ref)) {
        physRefs.push(ref);
      }
    }

    if (physRefs.length === 0) {
      const ext = isOldFormat ? '.xml' : '.fmx.xml';
      for (const name of entryNames) {
        if (name.endsWith(ext) && name !== docEntryName && !name.endsWith('.doc.xml')) {
          physRefs.push(name);
        }
      }
    }
    return physRefs;
  }

  const inFlightDownloads = new Map();

  async function downloadFmx(celex, lang = 'ENG') {
    const lockKey = `${celex}_${lang}`;
    if (inFlightDownloads.has(lockKey)) {
      return inFlightDownloads.get(lockKey);
    }

    const promise = (async () => {
      const fmx4Uri = await findFmx4Uri(celex, lang);
      const { type, urls } = await findDownloadUrls(fmx4Uri);

      const downloaded = [];
      let totalSize = 0;

      for (const url of urls) {
        const filename = url.split('/').pop();
        const destPath = path.join(FMX_DIR, filename);

        if (isValidCachedFile(destPath)) {
          const stat = fs.statSync(destPath);
          downloaded.push({ filename, path: destPath, cached: true, size: stat.size });
        } else {
          const response = await fetchWithTimeout(url, { method: 'HEAD' });
          const size = parseInt(response.headers.get('content-length')) || 0;
          totalSize += size;
          downloaded.push({ filename, path: destPath, cached: false, url, size });
        }
      }

      const requiredMB = totalSize / (1024 * 1024);
      if (requiredMB > 0) {
        const { evicted, freedMB } = evictOldestIfNeeded(requiredMB);
        if (evicted > 0) {
          console.log(`[Cache] Evicted ${evicted} file(s), freed ${freedMB} MB`);
        }
      }

      for (const file of downloaded) {
        if (file.cached) continue;

        const response = await fetchWithTimeout(file.url);
        if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${file.url}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileAtomically(file.path, buffer);
        if (!isValidCachedFile(file.path)) {
          throw new Error(`Downloaded Formex file failed integrity check: ${file.filename}`);
        }
        file.size = buffer.length;
      }

      // Safety net: the pre-download eviction pass above sizes itself from the
      // `content-length` header, which some upstream responses omit (yielding
      // size 0 and skipping eviction entirely). Now that files are written to
      // disk with their real sizes, re-check the on-disk total and evict the
      // oldest files if the cache still exceeds STORAGE_LIMIT_MB. Passing 0 as
      // the required size means only files beyond the existing cap are
      // evicted; sorted-by-mtime eviction order means the files just written
      // above are newest and won't be evicted by this pass.
      const { evicted: postWriteEvicted, freedMB: postWriteFreedMB } = evictOldestIfNeeded(0);
      if (postWriteEvicted > 0) {
        console.log(`[Cache] Post-download eviction removed ${postWriteEvicted} file(s), freed ${postWriteFreedMB} MB`);
      }

      return { fmx4Uri, type, files: downloaded };
    })().finally(() => {
      inFlightDownloads.delete(lockKey);
    });

    inFlightDownloads.set(lockKey, promise);
    return promise;
  }

  async function prepareLawPayload(celex, lang) {
    const requestedLang = lang || 'ENG';
    const memoized = getMemoizedPayload(celex, requestedLang);
    if (memoized) return memoized;

    console.log(`[API] Fetching ${celex} (lang: ${requestedLang})...`);
    const { fmx4Uri, type, files } = await downloadFmx(celex, requestedLang);

    if (files.length === 0) {
      throw new ClientError(`No FMX files found for ${celex}`, 404, 'fmx_not_found', { celex, lang: requestedLang });
    }

    let servePath;
    if (type === 'zip') {
      servePath = combineZipToXml(files[0].path);
    } else if (files.length > 1) {
      const combinedPath = files[0].path.replace(/\.xml$/, '.combined.xml');
      if (!isValidCachedFile(combinedPath)) {
        const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<COMBINED.FMX>'];
        for (const file of files) {
          let xml = fs.readFileSync(file.path, 'utf8');
          xml = xml.replace(/<\?xml[^?]*\?>/, '').trim();
          parts.push(xml);
        }
        parts.push('</COMBINED.FMX>');
        writeFileAtomically(combinedPath, parts.join('\n'), 'utf8');
        if (!isValidCachedFile(combinedPath)) {
          throw new Error(`Combined XML output failed integrity check: ${combinedPath}`);
        }
        console.log(`[API] Combined ${files.length} XML files -> ${path.basename(combinedPath)}`);
      }
      servePath = combinedPath;
    } else {
      servePath = files[0].path;
    }

    if (!isValidCachedFile(servePath)) {
      throw new ClientError('Cached file missing or corrupt', 404, 'cached_file_invalid', { celex, lang: requestedLang });
    }

    const result = { type, files, servePath };
    rememberServePath(celex, requestedLang, type, servePath, fmx4Uri);
    return result;
  }

  function sendLawResponse(res, servePath) {
    const stat = fs.statSync(servePath);

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Filename', path.basename(servePath));

    const stream = fs.createReadStream(servePath);
    stream.on('error', (err) => {
      console.error(`[API] Stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading cached file' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }

  return {
    findDownloadUrls,
    findFmx4Uri,
    prepareLawPayload,
    sendLawResponse,
  };
}

module.exports = {
  createFmxService,
};
