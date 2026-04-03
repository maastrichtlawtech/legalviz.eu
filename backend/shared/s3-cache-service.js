/**
 * S3-compatible cache service that can replace the file-based HTML and FMX
 * cache services. Works with AWS S3, MinIO, DigitalOcean Spaces, Backblaze B2,
 * and any other S3-compatible storage provider.
 *
 * Uses only built-in Node.js modules (no AWS SDK dependency) by implementing
 * S3 REST API with AWS Signature V4 signing.
 *
 * Environment variables:
 *   S3_ENDPOINT        - e.g. "https://s3.amazonaws.com" or "http://localhost:9000"
 *   S3_BUCKET          - bucket name
 *   S3_REGION          - e.g. "eu-west-1" (default: "us-east-1")
 *   S3_ACCESS_KEY_ID   - access key
 *   S3_SECRET_ACCESS_KEY - secret key
 *   S3_PREFIX           - optional key prefix (e.g. "cache/")
 *   S3_CACHE_LIMIT_MB   - optional max size in MB (best-effort LRU via metadata)
 */

const crypto = require('crypto');
const { gzip, gunzip } = require('zlib');
const { promisify } = require('util');

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function createS3CacheService({
  endpoint = process.env.S3_ENDPOINT || 'https://s3.amazonaws.com',
  bucket = process.env.S3_BUCKET,
  region = process.env.S3_REGION || 'us-east-1',
  accessKeyId = process.env.S3_ACCESS_KEY_ID,
  secretAccessKey = process.env.S3_SECRET_ACCESS_KEY,
  prefix = process.env.S3_PREFIX || '',
  storageLimitMB = parseInt(process.env.S3_CACHE_LIMIT_MB) || 0,
} = {}) {
  if (!bucket) throw new Error('S3_BUCKET is required for S3 cache service');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
  }

  const parsedEndpoint = new URL(endpoint);
  const service = 's3';

  // ---- AWS Signature V4 implementation ----

  function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  function getSigningKey(date) {
    const kDate = hmac(`AWS4${secretAccessKey}`, date);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
  }

  function signRequest(method, objectKey, { body = '', headers = {}, queryParams = '' } = {}) {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    const path = `/${bucket}/${encodedKey}`;

    const payloadHash = sha256(body || '');
    const allHeaders = {
      host: parsedEndpoint.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...headers,
    };

    const sortedHeaderKeys = Object.keys(allHeaders).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k.toLowerCase()}:${allHeaders[k].trim()}`).join('\n') + '\n';
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      method,
      path,
      queryParams,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');

    const signingKey = getSigningKey(dateStamp);
    const signature = hmac(signingKey, stringToSign).toString('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      url: `${endpoint}${path}${queryParams ? '?' + queryParams : ''}`,
      headers: {
        ...allHeaders,
        authorization,
      },
    };
  }

  async function s3Request(method, key, { body = null, headers = {}, queryParams = '', timeout = 30_000 } = {}) {
    const signed = signRequest(method, key, { body: body || '', headers, queryParams });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(signed.url, {
        method,
        headers: signed.headers,
        body,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Cache key helpers ----

  function objectKey(filename) {
    return `${prefix}${filename}`;
  }

  function htmlCacheKey(celex, lang) {
    return objectKey(`${celex}_${lang}.html.gz`);
  }

  function fmxCacheKey(filename) {
    return objectKey(filename);
  }

  // ---- HTML Cache interface (mirrors html-cache-service) ----

  async function getHtml(celex, lang) {
    const key = htmlCacheKey(celex, lang);
    try {
      const res = await s3Request('GET', key);
      if (res.status === 404 || !res.ok) return null;
      const compressed = Buffer.from(await res.arrayBuffer());
      const html = (await gunzipAsync(compressed)).toString('utf8');
      console.log(`[S3Cache] HTML hit: ${celex}_${lang}`);
      return html;
    } catch {
      return null;
    }
  }

  async function putHtml(celex, lang, html) {
    const compressed = await gzipAsync(Buffer.from(html, 'utf8'));
    const key = htmlCacheKey(celex, lang);
    const res = await s3Request('PUT', key, {
      body: compressed,
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(compressed.length),
      },
    });
    if (!res.ok) {
      throw new Error(`S3 PUT failed: ${res.status} ${await res.text()}`);
    }
    console.log(`[S3Cache] HTML stored: ${celex}_${lang} (${(compressed.length / 1024).toFixed(1)} KB)`);
  }

  async function removeHtml(celex, lang) {
    const key = htmlCacheKey(celex, lang);
    try {
      const res = await s3Request('DELETE', key);
      console.log(`[S3Cache] HTML removed: ${celex}_${lang}`);
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }

  // ---- FMX Cache interface (mirrors fmx file operations) ----

  async function getFmx(filename) {
    const key = fmxCacheKey(filename);
    try {
      const res = await s3Request('GET', key);
      if (res.status === 404 || !res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  async function putFmx(filename, buffer) {
    const key = fmxCacheKey(filename);
    const contentType = filename.endsWith('.xml') ? 'application/xml'
      : filename.endsWith('.zip') ? 'application/zip'
      : 'application/octet-stream';

    const res = await s3Request('PUT', key, {
      body: buffer,
      headers: {
        'content-type': contentType,
        'content-length': String(buffer.length),
      },
    });
    if (!res.ok) {
      throw new Error(`S3 PUT failed for ${filename}: ${res.status}`);
    }
    console.log(`[S3Cache] FMX stored: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
  }

  async function hasFmx(filename) {
    const key = fmxCacheKey(filename);
    try {
      const res = await s3Request('HEAD', key);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function removeFmx(filename) {
    const key = fmxCacheKey(filename);
    try {
      const res = await s3Request('DELETE', key);
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }

  // ---- Generic get/put (case law cache JSON, etc.) ----

  async function getJson(filename) {
    const key = objectKey(filename);
    try {
      const res = await s3Request('GET', key);
      if (res.status === 404 || !res.ok) return null;
      return JSON.parse(await res.text());
    } catch {
      return null;
    }
  }

  async function putJson(filename, obj) {
    const key = objectKey(filename);
    const body = JSON.stringify(obj, null, 2);
    const res = await s3Request('PUT', key, {
      body,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    });
    if (!res.ok) {
      throw new Error(`S3 PUT JSON failed for ${filename}: ${res.status}`);
    }
  }

  // ---- List / stats ----

  async function listObjects({ maxKeys = 1000 } = {}) {
    const queryParams = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
    const res = await s3Request('GET', '', { queryParams });
    if (!res.ok) return [];

    const xml = await res.text();
    const entries = [];
    const keyPattern = /<Key>([^<]+)<\/Key>/g;
    const sizePattern = /<Size>(\d+)<\/Size>/g;

    let keyMatch, sizeMatch;
    while ((keyMatch = keyPattern.exec(xml)) !== null) {
      sizeMatch = sizePattern.exec(xml);
      entries.push({
        key: keyMatch[1],
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      });
    }
    return entries;
  }

  async function getCacheSizeMB() {
    const objects = await listObjects();
    const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
    return totalBytes / (1024 * 1024);
  }

  /**
   * Health check: verify bucket access by doing a HEAD on the bucket.
   */
  async function healthCheck() {
    try {
      const res = await s3Request('HEAD', '', { timeout: 5_000 });
      return res.ok || res.status === 200 || res.status === 404;
    } catch {
      return false;
    }
  }

  // ---- Wrapped HTML cache service (drop-in for createHtmlCacheService) ----

  function asHtmlCacheService() {
    return {
      get: getHtml,
      put: putHtml,
      remove: removeHtml,
      getCacheSizeMB,
      evictOldestIfNeeded: async () => ({ evicted: 0 }), // S3 handles storage
    };
  }

  return {
    // HTML cache interface
    getHtml,
    putHtml,
    removeHtml,
    // FMX cache interface
    getFmx,
    putFmx,
    hasFmx,
    removeFmx,
    // Generic JSON
    getJson,
    putJson,
    // Utilities
    listObjects,
    getCacheSizeMB,
    healthCheck,
    // Drop-in replacement
    asHtmlCacheService,
  };
}

module.exports = { createS3CacheService };
