const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

class ChatProviderError extends Error {
  constructor(message, { status = 500, code = null, details = null } = {}) {
    super(message);
    this.name = 'ChatProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readErrorBody(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    try { return { message: await res.text() }; } catch { return {}; }
  }
  try { return await res.json(); } catch { return {}; }
}

function normalizeMessageText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (typeof part.value === 'string') return part.value;
        return '';
      })
      .join('')
      .trim();
  }
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.content === 'string') return value.content.trim();
  return '';
}

async function chatComplete({
  model,
  messages,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  temperature = 0.2,
  maxTokens = 1500,
  responseFormat = null,
  reasoning = null,
  signal,
}) {
  if (!apiKey) {
    throw new ChatProviderError('OPENROUTER_API_KEY is required', { status: 503, code: 'missing_api_key' });
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (responseFormat) {
    body.response_format = typeof responseFormat === 'string'
      ? { type: responseFormat }
      : responseFormat;
  }
  if (reasoning) {
    body.reasoning = reasoning;
  }
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://legalviz.local',
      'X-Title': 'EUR-Lex Visualiser',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new ChatProviderError(
      body?.error?.message || body?.message || res.statusText || 'Chat request failed',
      { status: res.status, code: body?.error?.code || null, details: body }
    );
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  // Some reasoning models (e.g. gpt-oss) put the final answer in `content`
  // but burn tokens on `reasoning` first; if content is empty, fall back to reasoning.
  const text = normalizeMessageText(msg.content) || normalizeMessageText(msg.reasoning) || '';
  return {
    text,
    usage: data?.usage || null,
    model: data?.model || model,
    finishReason: data?.choices?.[0]?.finish_reason || null,
  };
}

/**
 * Streaming variant — yields incremental events:
 *   { type: 'delta', text }         for each content chunk
 *   { type: 'done', usage, model }  once at the end
 * Throws ChatProviderError on upstream failure (incl. 402 insufficient credits).
 */
async function* chatStream({
  model,
  messages,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  temperature = 0.2,
  maxTokens = 1500,
  signal,
}) {
  if (!apiKey) {
    throw new ChatProviderError('OPENROUTER_API_KEY is required', { status: 503, code: 'missing_api_key' });
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://legalviz.local',
      'X-Title': 'EUR-Lex Visualiser',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true, usage: { include: true } }),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new ChatProviderError(
      body?.error?.message || body?.message || res.statusText || 'Chat request failed',
      { status: res.status, code: body?.error?.code || null, details: body }
    );
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finalUsage = null;
  let finalModel = model;
  let reasoningFallback = '';
  let sawContent = false;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE frames are separated by blank lines
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.usage) finalUsage = obj.usage;
        if (obj.model) finalModel = obj.model;
        const delta = obj.choices?.[0]?.delta || {};
        if (typeof delta.content === 'string' && delta.content.length) {
          sawContent = true;
          yield { type: 'delta', text: delta.content };
        } else if (typeof delta.reasoning === 'string' && delta.reasoning.length) {
          reasoningFallback += delta.reasoning;
        }
        // Some providers attach usage on the final chunk via message
        const msg = obj.choices?.[0]?.message;
        if (msg?.content) {
          sawContent = true;
          yield { type: 'delta', text: msg.content };
        }
      }
    }
  }

  // If content never came through (reasoning model with no final content),
  // fall back to reasoning so the user sees something.
  if (!sawContent && reasoningFallback) {
    yield { type: 'delta', text: reasoningFallback };
  }

  yield { type: 'done', usage: finalUsage, model: finalModel };
}

module.exports = { chatComplete, chatStream, ChatProviderError, normalizeMessageText };
