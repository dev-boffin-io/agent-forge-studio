'use strict';

// Sessions — one JSON file per session under <studio data dir>/sessions/. Same shape as the sibling
// Forge apps: role-tagged messages ({role, content, toolCalls?, toolCallId?, thinking?, error?}),
// an optional compact summary, archiving, per-agent selection. Writes are atomic; load repairs
// obviously broken files instead of crashing.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('./log');

const MAX_TOOL_CHARS = 60000;   // tool output stored in a session message
const MAX_MSG_CHARS = 200000;   // a single message (user or assistant)
const MAX_MESSAGES = 2000;      // hard cap; compaction keeps the working set far below this

const dir = () => path.join(require('./config').studioDir(), 'sessions');
const file = (id) => path.join(dir(), `${id}.json`);

function newId() { return crypto.randomUUID(); }

function createSession({ title = 'New session', agent = 'create' } = {}) {
  const s = { id: newId(), title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, agent, summary: '', messages: [] };
  saveSession(s);
  return s;
}

function loadSession(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('bad session id'), { code: 'ENOENT' });
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    // a truncated/corrupted file: keep a copy for forensics, then fail this load cleanly
    try { fs.copyFileSync(file(id), file(id) + '.broken'); } catch { /* ignore */ }
    log.warn('sessions', `session ${id} is corrupt; a copy was saved as .broken`, e);
    throw Object.assign(new Error('session file is corrupt'), { code: 'ENOENT' });
  }
  if (!s || !Array.isArray(s.messages)) throw Object.assign(new Error('session file is invalid'), { code: 'ENOENT' });
  s.messages = s.messages.filter((m) => m && typeof m === 'object' && typeof m.role === 'string');
  for (const m of s.messages) {
    if (typeof m.content === 'string' && m.content.length > MAX_MSG_CHARS) m.content = m.content.slice(0, MAX_MSG_CHARS) + '\n…[truncated]';
    if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) if (tc && tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments.length > MAX_TOOL_CHARS) tc.function.arguments = tc.function.arguments.slice(0, MAX_TOOL_CHARS);
  }
  return s;
}

/**
 * Accept either a session id or the loaded session object (the agent loop passes the object so
 * in-memory history stays in sync with what gets persisted). String ids are read from disk.
 */
function resolve(ref) {
  if (ref && typeof ref === 'object' && Array.isArray(ref.messages) && ref.id) return ref;
  return loadSession(ref);
}

function saveSession(s) {
  s.updatedAt = new Date().toISOString();
  const tmp = file(s.id) + '.tmp';
  const data = JSON.stringify(s, null, 2);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file(s.id));
}

function listSessions({ archived = false } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(dir()).filter((f) => f.endsWith('.json') && !f.endsWith('.broken.json') && !f.endsWith('.tmp')); } catch { return []; }
  const out = [];
  for (const f of ids) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
      if (!s || !Array.isArray(s.messages)) continue;
      if (!!s.archived !== !!archived) continue;
      out.push({ id: s.id, title: s.title, agent: s.agent || 'create', createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages.length, summary: s.summary || '' });
    } catch { /* skip broken */ }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function deleteSession(id) {
  try { fs.unlinkSync(file(id)); return true; } catch { return false; }
}

function archiveSession(id, archived = true) {
  try {
    const s = loadSession(id);
    s.archived = !!archived;
    saveSession(s);
    return s;
  } catch { return null; }
}

function setTitle(ref, title) {
  const s = resolve(ref);
  s.title = String(title || 'New session').slice(0, 200);
  saveSession(s);
  return s;
}

function setAgent(ref, agent) {
  const s = resolve(ref);
  s.agent = String(agent || 'create');
  saveSession(s);
  return s;
}

/** append one message (role/content/toolCalls/toolCallId/thinking/error) */
function append(ref, msg) {
  const s = resolve(ref);
  const m = { role: msg.role, content: typeof msg.content === 'string' ? msg.content.slice(0, MAX_MSG_CHARS) : '' };
  if (msg.thinking) m.thinking = String(msg.thinking).slice(0, MAX_TOOL_CHARS);
  if (msg.toolCalls && msg.toolCalls.length) m.toolCalls = msg.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function && tc.function.name, arguments: String((tc.function && tc.function.arguments) || '').slice(0, MAX_TOOL_CHARS) } }));
  if (msg.toolCallId) m.toolCallId = msg.toolCallId;
  if (msg.error) m.error = String(msg.error).slice(0, 2000);
  if (msg.name) m.name = msg.name;
  s.messages.push(m);
  while (s.messages.length > MAX_MESSAGES) s.messages.shift();
  saveSession(s);
  return m;
}

/** replace the last assistant message's content in place (streaming assembly) */
function updateLastAssistant(ref, content) {
  const s = resolve(ref);
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'assistant') {
      s.messages[i].content = String(content).slice(0, MAX_MSG_CHARS);
      saveSession(s);
      return;
    }
  }
  s.messages.push({ role: 'assistant', content: String(content).slice(0, MAX_MSG_CHARS) });
  saveSession(s);
}

/** edit or delete a user message by index (the pencil in the UI) */
function editMessage(ref, index, newContent) {
  const s = resolve(ref);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= s.messages.length) throw new Error('bad message index');
  if (newContent == null) {
    s.messages.splice(i, 1);
  } else {
    s.messages[i].content = String(newContent).slice(0, MAX_MSG_CHARS);
    s.messages.splice(i + 1);   // everything after an edited user turn is stale
  }
  saveSession(s);
  return s;
}

/** messages kept for the model: prune tool outputs + old turns, keep recent window */
function pruneForModel(s, { keepRecent = 30, maxTool = MAX_TOOL_CHARS } = {}) {
  const msgs = s.messages.slice();
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = { ...msgs[i] };
    const isRecent = i >= msgs.length - keepRecent;
    if (m.role === 'tool' && !isRecent && typeof m.content === 'string' && m.content.length > 1500) {
      m.content = m.content.slice(0, 1500) + '\n…[older tool output pruned]';
    }
    if (typeof m.content === 'string' && m.content.length > maxTool) m.content = m.content.slice(0, maxTool);
    out.push(m);
  }
  return out;
}

module.exports = {
  createSession, loadSession, resolve, saveSession, listSessions, deleteSession, archiveSession,
  setTitle, setAgent, append, updateLastAssistant, editMessage, pruneForModel,
  newId, MAX_TOOL_CHARS, MAX_MSG_CHARS,
};
