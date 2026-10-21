'use strict';

// ollama — native /api/chat NDJSON streaming, with tool calling and thinking support.
// Normalized result: {text, thinking, toolCalls, model}.

const { fetchOk } = require('./errors');
const log = require('./log');

function toOllamaMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content || '' };
    if (m.toolCalls && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.function && tc.function.name, arguments: safeJson(tc.function && tc.function.arguments) } }));
    }
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    if (m.name) out.name = m.name;
    return out;
  });
}

function safeJson(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch {
    // some models emit trailing commas / single quotes in tool args; try a light fix, else wrap
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')); } catch { return { _raw: s }; }
  }
}

async function sendChat(provider, opts) {
  const { model, messages, temperature = 0.6, numCtx = 0, thinking = false, tools = [], signal, onToken, onThinking, onToolCall } = opts;
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    options: { temperature },
  };
  if (numCtx) body.options.num_ctx = numCtx;
  if (thinking) body.options.think = true;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
  }
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchOk(provider.endpoint + '/api/chat', {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }, { source: 'Ollama chat', where: provider.endpoint });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '', thinkingText = '';
  const toolCalls = [];
  let doneModel = model;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(String(obj.error));
      if (obj.model) doneModel = obj.model;
      const msg = obj.message || {};
      if (msg.thinking) { thinkingText += msg.thinking; if (onThinking) onThinking(msg.thinking); }
      if (msg.content) { text += msg.content; if (onToken) onToken(msg.content); }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
          const norm = { id: 'call_' + toolCalls.length + '_' + Date.now(), type: 'function', function: { name: fn.name, arguments: args } };
          toolCalls.push(norm);
          if (onToolCall) onToolCall(norm);
        }
      }
    }
  }
  return { text, thinking: thinkingText, toolCalls, model: doneModel };
}

async function listModels(provider) {
  const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await fetchOk(provider.endpoint + '/api/tags', { headers }, { source: 'Ollama models', where: provider.endpoint });
  const data = await res.json();
  return (data.models || []).map((m) => ({ id: m.name, name: m.name, size: m.size }));
}

module.exports = { sendChat, listModels, toOllamaMessages, safeJson };
