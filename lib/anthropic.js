'use strict';

// anthropic — Anthropic Messages API SSE streaming, with thinking + tool_use support.
// Normalized result: {text, thinking, toolCalls, model}.

const { fetchOk } = require('./errors');
const log = require('./log');

function toAnthropicMessages(messages) {
  // Anthropic alternates user/assistant strictly and puts tools in a separate role.
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content || '' });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.thinking) blocks.push({ type: 'thinking', thinking: m.thinking, signature: '' });
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (m.toolCalls && m.toolCalls.length) {
        for (const tc of m.toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
        }
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '' }] });
    }
  }
  // merge consecutive same-role messages (Anthropic rejects strict alternation violations)
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const pa = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }];
      const ma = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      prev.content = pa.concat(ma);
    } else merged.push(m);
  }
  return merged;
}

function parseSSE(chunk) {
  const events = [];
  for (const block of chunk.split(/\n\n+/)) {
    for (const line of block.split(/\n/)) {
      const m = /^event:\s*(.*)$/.exec(line.trim());
      const d = /^data:\s*(.*)$/.exec(line.trim());
      if (d) { try { events.push(JSON.parse(d[1])); } catch { /* ignore */ } }
      else if (m) events.push({ _event: m[1].trim() });
    }
  }
  return events;
}

async function sendChat(provider, opts) {
  const { model, messages, temperature = 0.6, thinking = false, tools = [], signal, onToken, onThinking, onToolCall } = opts;
  const system = [opts.system, opts.voice].filter(Boolean).join('\n\n');
  const body = {
    model,
    max_tokens: opts.maxTokens || 8192,
    messages: toAnthropicMessages(messages),
    temperature,
  };
  if (system) body.system = system;
  if (thinking) { body.thinking = { type: 'enabled', budget_tokens: 4096 }; body.temperature = 1; }
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
  }
  const headers = {
    'content-type': 'application/json',
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
  };
  const res = await fetchOk(provider.endpoint + '/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }, { source: 'Anthropic chat', where: provider.endpoint });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '', thinkingText = '';
  const toolAcc = new Map();
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
        if (ev.model) doneModel = ev.model;
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          toolAcc.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, arguments: '' });
        }
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') { text += ev.delta.text; if (onToken) onToken(ev.delta.text); }
          if (ev.delta.type === 'thinking_delta') { thinkingText += ev.delta.thinking; if (onThinking) onThinking(ev.delta.thinking); }
          if (ev.delta.type === 'input_json_delta' && toolAcc.has(ev.index)) {
            toolAcc.get(ev.index).arguments += ev.delta.partial_json;
          }
        }
      }
    }
  }
  const toolCalls = [];
  for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.name) continue;
    const norm = { id: acc.id || 'call_' + toolCalls.length, type: 'function', function: { name: acc.name, arguments: acc.arguments || '{}' } };
    toolCalls.push(norm);
    if (onToolCall) onToolCall(norm);
  }
  return { text, thinking: thinkingText, toolCalls, model: doneModel };
}

async function listModels(provider) {
  const headers = { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' };
  const res = await fetchOk(provider.endpoint + '/v1/models', { headers }, { source: 'Anthropic models', where: provider.endpoint });
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, name: m.id || m.display_name }));
}

module.exports = { sendChat, listModels, toAnthropicMessages, parseSSE };
