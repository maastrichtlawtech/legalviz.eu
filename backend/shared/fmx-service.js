const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ClientError } = require('./api-utils');

/** Trailing `.<LANG>.fmx4` on a Cellar manifestation URI, any 3-letter language. */
const FMX4_ANY_LANG = /\.[A-Z]{3}\.fmx4$/;

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
    if (response.status === 404) throw new ClientError('Law not found in EUR-Lex Cellar', 404);
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

    if (!fmx4) throw new ClientError(`No Formex data available for this law in language ${lang}`, 404);
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

    throw new ClientError('No downloadable Formex files found for this law', 404);
  }

  function combineZipToXml(zipPath) {
    const combinedPath = zipPath.replace(/\.zip$/, '.combined.xml');
    if (fs.existsSync(combinedPath)) return combinedPath;

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

    fs.writeFileSync(combinedPath, parts.join('\n'), 'utf8');
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

    fs.writeFileSync(combinedPath, parts.join('\n'), 'utf8');
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

        if (fs.existsSync(destPath)) {
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
        fs.writeFileSync(file.path, buffer);
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

      return { type, files: downloaded };
    })().finally(() => {
      inFlightDownloads.delete(lockKey);
    });

    inFlightDownloads.set(lockKey, promise);
    return promise;
  }

  async function prepareLawPayload(celex, lang) {
    console.log(`[API] Fetching ${celex} (lang: ${lang})...`);
    const { type, files } = await downloadFmx(celex, lang);

    if (files.length === 0) {
      throw new ClientError(`No FMX files found for ${celex}`, 404, 'fmx_not_found', { celex, lang });
    }

    let servePath;
    if (type === 'zip') {
      servePath = combineZipToXml(files[0].path);
    } else if (files.length > 1) {
      const combinedPath = files[0].path.replace(/\.xml$/, '.combined.xml');
      if (!fs.existsSync(combinedPath)) {
        const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<COMBINED.FMX>'];
        for (const file of files) {
          let xml = fs.readFileSync(file.path, 'utf8');
          xml = xml.replace(/<\?xml[^?]*\?>/, '').trim();
          parts.push(xml);
        }
        parts.push('</COMBINED.FMX>');
        fs.writeFileSync(combinedPath, parts.join('\n'), 'utf8');
        console.log(`[API] Combined ${files.length} XML files -> ${path.basename(combinedPath)}`);
      }
      servePath = combinedPath;
    } else {
      servePath = files[0].path;
    }

    if (!fs.existsSync(servePath)) {
      throw new ClientError('Cached file missing', 404, 'cached_file_missing', { celex, lang });
    }

    return { type, files, servePath };
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
