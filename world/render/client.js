'use strict';
// Minimal OpenAI-compatible chat client. Endpoint and key come from the environment:
//   WSB_LLM_URL (default https://openrouter.ai/api/v1), WSB_LLM_KEY (falls back to OPEN_ROUTER_API_KEY / OPENROUTER_API_KEY).
// Model profiles (world/render/models.json) carry per-model request extras, e.g. how to keep reasoning short.
const PROFILES = require('./models.json');

const baseUrl = () => (process.env.WSB_LLM_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const apiKey = () => process.env.WSB_LLM_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat({ model, messages, maxTokens = 1200, temperature = 0.9, retries = 4, json = false }) {
  const extra = PROFILES[model]?.extra || {};
  const body = { model, messages, max_tokens: maxTokens + (PROFILES[model]?.reasoning_budget || 0), temperature, usage: { include: true }, ...extra };
  if (json) body.response_format = { type: 'json_object' };
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });
      const text = await res.text();
      let d;
      try { d = JSON.parse(text); } catch { d = { error: { message: text.slice(0, 300) } }; }
      if (!res.ok || d.error) {
        last = new Error(`${res.status} ${d.error?.message || 'error'}`);
        if (res.status === 400 || res.status === 401 || res.status === 402) throw last;
      } else {
        const msg = d.choices?.[0]?.message || {};
        return {
          text: (msg.content || '').trim(), finish: d.choices?.[0]?.finish_reason, provider: d.provider, ms: Date.now() - t0,
          usage: { in: d.usage?.prompt_tokens, out: d.usage?.completion_tokens, reasoning: d.usage?.completion_tokens_details?.reasoning_tokens, cost: d.usage?.cost },
        };
      }
    } catch (err) {
      last = err;
      if (/^40[012] /.test(err.message)) throw err;
    }
    await sleep(2000 * 2 ** attempt);
  }
  throw last;
}

// Run fn over items with at most n in flight.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

module.exports = { chat, pool };
