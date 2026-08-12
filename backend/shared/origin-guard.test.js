const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_ALLOWED_ORIGINS, createOriginAllowlistMiddleware } = require("./origin-guard");

function run(middleware, origin) {
  const req = { headers: origin === undefined ? {} : { origin } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res };
}

test("allows the site's own origins and blocks third-party pages", () => {
  const middleware = createOriginAllowlistMiddleware({ allowedOrigins: DEFAULT_ALLOWED_ORIGINS.join(",") });

  assert.equal(run(middleware, "https://legalviz.eu").passed, true);
  assert.equal(run(middleware, "http://localhost:5173").passed, true);

  const blocked = run(middleware, "https://evil.example");
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 403);
  assert.equal(blocked.res.payload.code, "origin_not_allowed");
});

test("allows requests with no Origin header (curl, CLI, MCP clients)", () => {
  const middleware = createOriginAllowlistMiddleware({ allowedOrigins: "https://legalviz.eu" });
  assert.equal(run(middleware, undefined).passed, true);
});

test("ignores a trailing slash on either side of the comparison", () => {
  const middleware = createOriginAllowlistMiddleware({ allowedOrigins: "https://legalviz.eu/" });
  assert.equal(run(middleware, "https://legalviz.eu").passed, true);
});

test("'*' disables the guard for self-hosted deployments", () => {
  const middleware = createOriginAllowlistMiddleware({ allowedOrigins: "*" });
  assert.equal(run(middleware, "https://anything.example").passed, true);
});

test("falls back to the built-in allowlist when nothing is configured", () => {
  const middleware = createOriginAllowlistMiddleware({ allowedOrigins: "" });
  assert.equal(run(middleware, "https://legalviz.eu").passed, true);
  assert.equal(run(middleware, "https://evil.example").passed, false);
});
