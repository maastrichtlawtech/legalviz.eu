const test = require('node:test');
const assert = require('node:assert/strict');

const { chatComplete, normalizeMessageText } = require('./openrouter-chat');

test('chatComplete passes response_format and reasoning when requested', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { total_tokens: 3 },
      }),
    };
  };

  try {
    const result = await chatComplete({
      model: 'test-model',
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      responseFormat: 'json_object',
      reasoning: { max_tokens: 256, exclude: true },
    });

    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
    assert.deepEqual(capturedBody.reasoning, { max_tokens: 256, exclude: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizeMessageText extracts provider content parts', () => {
  assert.equal(
    normalizeMessageText([
      { type: 'text', text: '{"1":"' },
      { type: 'text', text: 'Data protection"}' },
    ]),
    '{"1":"Data protection"}'
  );
});
