'use strict';

// openai — OpenAI-compatible /chat/completions SSE streaming (works with LM Studio, vLLM,
// OpenRouter, Groq, DeepSeek, etc). Normalized result: {text, thinking, toolCalls, model}.

const { fetchOk } = require('./errors');
const log = require('./log');

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system' && system) continue; // avoid duplicating an injected system prompt
    const o = { role: m.role, content: m.content || '' };
    if (m.toolCalls && m.toolCalls.length) {
      o.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments } }));
    }
    if (m.toolCallId) { o.role = 'tool'; o.tool_call_id = m.toolCallId; }
    out.push(o);
  }
  return out;
}

function parseSSE(chunk) {
  // SSE frames: "data: {...}" / "data: [DONE]" separated by blank lines
  const events = [];
  for (const block of chunk.split(/\n\n+/)) {
    for (const line of block.split(/\n/)) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const d = m[1].trim();
      if (d === '[DONE]') { events.push({ done: true }); continue; }
      try { events.push(JSON.parse(d)); } catch { /* ignore partial */ }
    }
  }
  return events;
}

async function sendChat(provider, opts) {
  const { model, messages, temperature = 0.6, numCtx = 0, thinking = false, tools = [], signal, onToken, onThinking, onToolCall } = opts;
  const body = {
    model,
    messages: toOpenAIMessages(messages, opts.system),
    stream: true,
    temperature,
  };
  if (numCtx) body.max_tokens = Math.max(1024, numCtx > 4096 ? 8192 : numCtx);
  if (thinking) body.reasoning_effort = 'medium';
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
  }
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchOk(provider.endpoint + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }, { source: 'OpenAI chat', where: provider.endpoint });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '', thinkingText = '';
  const toolAcc = new Map(); // index -> {name, arguments}
  let doneModel = model;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      for (const ev of parseSSE(block)) {
        if (ev.done) continue;
        const ch = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (!ch) continue;
        if (ev.model) doneModel = ev.model;
        if (ch.reasoning_content) { thinkingText += ch.reasoning_content; if (onThinking) onThinking(ch.reasoning_content); }
        if (ch.content) { text += ch.content; if (onToken) onToken(ch.content); }
        if (Array.isArray(ch.tool_calls)) {
          for (const tc of ch.tool_calls) {
            const i = tc.index != null ? tc.index : toolAcc.size;
            if (!toolAcc.has(i)) toolAcc.set(i, { name: '', arguments: '' });
            const acc = toolAcc.get(i);
            if (tc.function && tc.function.name) acc.name += tc.function.name;
            if (tc.function && tc.function.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  const toolCalls = [];
  for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.name) continue;
    const norm = { id: 'call_' + toolCalls.length + '_' + Date.now(), type: 'function', function: { name: acc.name, arguments: acc.arguments || '{}' } };
    toolCalls.push(norm);
    if (onToolCall) onToolCall(norm);
  }
  return { text, thinking: thinkingText, toolCalls, model: doneModel };
}

async function listModels(provider) {
  const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await fetchOk(provider.endpoint + '/models', { headers }, { source: 'OpenAI models', where: provider.endpoint });
  const data = await res.json();
  return (data.data || data.models || []).map((m) => ({ id: m.id || m.name, name: m.id || m.name }));
}

module.exports = { sendChat, listModels, toOpenAIMessages, parseSSE };
