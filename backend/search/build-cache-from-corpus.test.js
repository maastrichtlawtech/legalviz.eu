const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveDateFromCelex } = require("./build-cache-from-corpus");

test("deriveDateFromCelex returns the year encoded in a primary-act CELEX", () => {
  assert.equal(deriveDateFromCelex("31998L0034"), "1998");
  assert.equal(deriveDateFromCelex("31968R0259"), "1968");
  assert.equal(deriveDateFromCelex("32016R0679"), "2016");
});

test("deriveDateFromCelex returns null for an unparseable CELEX", () => {
  assert.equal(deriveDateFromCelex(""), null);
  assert.equal(deriveDateFromCelex(null), null);
  assert.equal(deriveDateFromCelex("not-a-celex"), null);
});
