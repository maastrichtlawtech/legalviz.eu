const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { registerTools } = require('./register-tools');

const SERVER_INFO = { name: 'eurlex', version: '1.0.0' };

function methodNotAllowed(req, res) {
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

module.exports = { registerMcpEndpoint };
