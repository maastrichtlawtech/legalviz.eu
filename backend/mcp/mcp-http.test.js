const test = require('node:test');
const assert = require('node:assert/strict');

const { describeBody } = require('./mcp-http');

test('describeBody names the JSON-RPC method', () => {
  assert.equal(describeBody({ jsonrpc: '2.0', id: 1, method: 'initialize' }), 'initialize');
  assert.equal(describeBody({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'notifications/initialized');
  assert.equal(describeBody({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 'tools/list');
});

test('describeBody logs the tool name and structural arguments', () => {
  const summary = describeBody({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_law_part', arguments: { celex: '32016R0679', part: 'article', number: '17', lang: 'EN' } },
  });
  assert.equal(summary, 'tools/call get_law_part celex=32016R0679 part=article number=17 lang=EN');
});

test('describeBody never logs query text, only its length', () => {
  const summary = describeBody({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'search_eu_law', arguments: { query: '  my private search phrase  ' } },
  });
  assert.equal(summary, 'tools/call search_eu_law query.len=24');
  assert.ok(!summary.includes('private'));
});

test('describeBody keeps a hostile argument from forging a log line', () => {
  const summary = describeBody({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_law_part', arguments: { celex: '3\n[MCP] forged 200 0ms' } },
  });
  assert.ok(!summary.includes('\n'));
  assert.equal(summary, 'tools/call get_law_part celex=3 [MCP] forged 200 0ms');
});

test('describeBody truncates an overlong argument', () => {
  const summary = describeBody({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'get_law_part', arguments: { celex: 'X'.repeat(200) } },
  });
  assert.ok(summary.endsWith('…'));
  assert.ok(summary.length < 120);
});

test('describeBody caps a batch request', () => {
  const batch = Array.from({ length: 9 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/list' }));
  assert.equal(describeBody(batch), 'tools/list + tools/list + tools/list + tools/list + tools/list + 4 more');
  assert.equal(describeBody([]), 'empty batch');
});

test('describeBody survives a malformed or absent body', () => {
  assert.equal(describeBody(undefined), 'no body');
  assert.equal(describeBody(null), 'malformed');
  assert.equal(describeBody('nonsense'), 'malformed');
  assert.equal(describeBody({ jsonrpc: '2.0', id: 7, result: {} }), 'response');
  assert.equal(describeBody({ jsonrpc: '2.0' }), 'malformed');
});
