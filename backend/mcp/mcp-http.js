const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { registerTools } = require('./register-tools');

const SERVER_INFO = { name: 'eurlex', version: '1.0.0' };

// Tool arguments that are safe to log. They are structural identifiers a client
// chose from our own data, not user text: `query` is a phrase a person typed, so
// it is logged only as a length (analytics deliberately stores no query text
// either — see `privacy.searchQueriesStored` in shared/analytics.js).
const LOGGED_ARGS = ['celex', 'part', 'number', 'article', 'lang', 'version', 'limit', 'offset'];

// A batch request is legal JSON-RPC, but logging an unbounded array would let a
// client write arbitrarily long lines into the host's log.
const MAX_LOGGED_BATCH = 5;

/**
 * Flatten a value into something that cannot forge a log line: no newlines, no
 * control characters, bounded length.
 */
function logSafe(value, maxLength = 64) {
  const text = String(value).replace(/[^\x20-\x7e]+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** One-line description of a single JSON-RPC message, with no user text in it. */
function describeMessage(message) {
  if (!message || typeof message !== 'object') return 'malformed';
  if (typeof message.method !== 'string') return message.id !== undefined ? 'response' : 'malformed';
  if (message.method !== 'tools/call') return message.method;

  const { name, arguments: args } = message.params || {};
  const parts = [`tools/call ${logSafe(name || '?', 40)}`];
  for (const key of LOGGED_ARGS) {
    const value = args?.[key];
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${logSafe(value, 32)}`);
  }
  // Length only: enough to tell a real search from an empty probe.
  if (typeof args?.query === 'string') parts.push(`query.len=${args.query.trim().length}`);
  return parts.join(' ');
}

function describeBody(body) {
  if (Array.isArray(body)) {
    if (body.length === 0) return 'empty batch';
    const shown = body.slice(0, MAX_LOGGED_BATCH).map(describeMessage).join(' + ');
    const hidden = body.length - MAX_LOGGED_BATCH;
    return hidden > 0 ? `${shown} + ${hidden} more` : shown;
  }
  return body === undefined ? 'no body' : describeMessage(body);
}

/**
 * Log one line per request once the response is done, so the status code and
 * duration are real. Streamable HTTP puts everything on one URL, so without
 * this a proxy log shows an identical `POST /mcp` for a handshake, a
 * `tools/list` and a `tools/call` alike, and cannot distinguish a client doing
 * useful work from one looping on a rejected handshake.
 */
function logOnFinish(req, res, summary) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ua = logSafe(req.headers?.['user-agent'] || '-', 120);
    console.log(`[MCP] ${summary} ua="${ua}" ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
}

function methodNotAllowed(req, res) {
  logOnFinish(req, res, `${req.method} (not allowed)`);
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
    id: null,
  });
}

/**
 * Mount a stateless Streamable HTTP MCP endpoint at POST /mcp.
 *
 * Each request spins up a fresh McpServer + transport (no session state), so
 * many independent clients can share the one deployment. Tools reuse the same
 * service instances, caches, and analytics as the REST API.
 *
 * deps: everything registerTools needs plus rateLimitMiddleware.
 */
function registerMcpEndpoint(app, deps) {
  const { rateLimitMiddleware } = deps;

  app.post('/mcp', rateLimitMiddleware, async (req, res) => {
    let transport;
    let server;
    // Read the body before handleRequest: the transport consumes it, and a
    // rejected request (e.g. 406 on a missing Accept header) never reaches a tool.
    logOnFinish(req, res, describeBody(req.body));
    try {
      server = new McpServer(SERVER_INFO);
      registerTools(server, deps);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        try { transport?.close(); } catch { /* noop */ }
        try { server?.close(); } catch { /* noop */ }
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] request failed:', err?.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless server: no SSE stream to open, no session to delete.
  app.get('/mcp', rateLimitMiddleware, methodNotAllowed);
  app.delete('/mcp', rateLimitMiddleware, methodNotAllowed);
}

module.exports = { registerMcpEndpoint, describeBody };
