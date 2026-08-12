const test = require("node:test");
const assert = require("node:assert/strict");

const { createGenerationLimitMiddleware, createRateLimitMiddleware } = require("./rate-limit");

function createReq(ip = "1.2.3.4") {
  return { ip, headers: {} };
}

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

/** Run the middleware once; returns { passed, res, req }. */
function invoke(middleware, req = createReq()) {
  const res = createRes();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res, req };
}

test("generic limiter rejects once the per-IP window is exhausted", () => {
  const middleware = createRateLimitMiddleware({ windowMs: 60_000, max: 2 });
  try {
    assert.equal(invoke(middleware).passed, true);
    assert.equal(invoke(middleware).passed, true);
    const third = invoke(middleware);
    assert.equal(third.passed, false);
    assert.equal(third.res.statusCode, 429);
    // A different IP has its own budget.
    assert.equal(invoke(middleware, createReq("5.6.7.8")).passed, true);
  } finally {
    middleware.close();
  }
});

test("generation limiter only counts requests the route actually charges", () => {
  const middleware = createGenerationLimitMiddleware({ windowMs: 60_000, max: 2 });
  try {
    // Cache hits: the route never calls chargeGeneration, so the budget is
    // untouched no matter how many requests arrive.
    for (let i = 0; i < 10; i += 1) {
      assert.equal(invoke(middleware).passed, true);
    }

    const first = invoke(middleware);
    first.req.chargeGeneration();
    const second = invoke(middleware);
    second.req.chargeGeneration();

    const third = invoke(middleware);
    assert.equal(third.passed, false);
    assert.equal(third.res.statusCode, 429);
    assert.equal(third.res.payload.code, "generation_rate_limited");
    assert.ok(third.res.payload.retryAfterMs > 0);
  } finally {
    middleware.close();
  }
});

test("generation limiter budgets each IP separately and resets after the window", async () => {
  const middleware = createGenerationLimitMiddleware({ windowMs: 20, max: 1 });
  try {
    const spender = invoke(middleware);
    spender.req.chargeGeneration();
    assert.equal(invoke(middleware).passed, false);

    assert.equal(invoke(middleware, createReq("9.9.9.9")).passed, true);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(invoke(middleware).passed, true, "window reset restores the budget");
  } finally {
    middleware.close();
  }
});
