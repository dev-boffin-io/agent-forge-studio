'use strict';

/* agent-forge-studio — browser client.
   Talks to server.js: /api/config, /api/models, /api/sessions (+ /run SSE), /api/files, /api/file,
   /api/agents|skills|commands, /api/youtube/*, /api/answer. */

const $ = (id) => document.getElementById(id);

const state = {
  config: {}, model: '', workDir: '',
  sessions: [], sessionId: null, agents: [],
  activeFile: null, streaming: false, abortController: null,
  messages: [], archivedView: false,
  modelOptions: [],                // [{ref, name, provider, providerType, parameterSize, error}]
  installedSkills: [],             // GitHub-installed skills with their source metadata
};

/* ---------- helpers ---------- */

function setStatus(text, cls = '') {
  const el = $('connStatus');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
  const m = $('mobileStatus');
  if (m) { m.textContent = text; m.className = 'status' + (cls ? ' ' + cls : ''); }
}

function showMetricsBadge({ iterations, elapsedMs }) {
  const el = $('metricsBadge');
  const parts = [];
  if (iterations > 0) parts.push(`${iterations} it`);
  if (elapsedMs > 0) parts.push(`${(elapsedMs / 1000).toFixed(1)} s`);
  el.hidden = !parts.length;
  el.textContent = parts.join(' · ');
  const mob = $('mobileMetrics');
  if (mob) { mob.hidden = !parts.length; mob.textContent = el.textContent; }
}

async function api(path, options = {}) {
  const { timeoutMs = 60000, retry = (options.method || 'GET') === 'GET', ...rest } = options;
  let lastErr;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, signal: ac.signal, ...rest });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        if (res.status < 500) throw err;
        lastErr = err;
      } else return data;
    } catch (err) {
      if (err.status && err.status < 500) throw err;
      lastErr = err.name === 'AbortError' ? new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`) : (err.status ? err : new Error('cannot reach the studio server — is it still running?'));
    } finally { clearTimeout(timer); }
    if (attempt === 0 && retry) await new Promise((r) => setTimeout(r, 700));
  }
  throw lastErr;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
let bulkRender = false;
const scrollChat = () => { if (!bulkRender) $('messages').scrollTop = $('messages').scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/* ---------- config ---------- */

async function loadConfig() {
  state.config = await api('/api/config');
  $('endpoint').value = state.config.endpoint || '';
  state.model = state.config.model || '';
  state.workDir = state.config.workDir || state.workDir;
  fillYtCreds(state.config.youtube || {});
  try {
    const ig = state.config.instagram || {};
    $('igClientId').value = ig.clientId || '';
    if ($('igClientSecret')) $('igClientSecret').value = ig.clientSecretMasked || '';
    const igs = $('igAuthStatus');
    const igb = $('connectIgAgent'); if (igb) igb.disabled = !ig.hasCredentials || !!ig.hasToken;
    if (igs) { if (ig.hasToken) { igs.textContent = ig.username ? '✓ Connected (@'+ig.username+')' : '✓ Connected'; igs.className = 'hint-line yt-creds-status ok'; } else if (ig.hasCredentials) { igs.textContent = 'Credentials saved — press Connect Agent'; igs.className = 'hint-line yt-creds-status'; } else { igs.textContent = 'Add Client ID & Secret, save keys'; igs.className = 'hint-line yt-creds-status'; } }
  } catch {}
  try {
    const fb = state.config.facebook || {};
    $('fbClientId').value = fb.clientId || '';
    if ($('fbClientSecret')) $('fbClientSecret').value = fb.clientSecretMasked || '';
    const fbb = $('connectFbAgent'); if (fbb) fbb.disabled = !fb.hasCredentials || !!fb.hasToken;
    if (fbs) { if (fb.hasToken) { fbs.textContent = fb.pages && fb.pages.length ? '✓ Connected ('+fb.pages.length+' page'+(fb.pages.length===1?'':'s')+')' : '✓ Connected'; fbs.className = 'hint-line yt-creds-status ok'; } else if (fb.hasCredentials) { fbs.textContent = 'Credentials saved — press Connect Agent'; fbs.className = 'hint-line yt-creds-status'; } else { fbs.textContent = 'Add Client ID & Secret, save keys'; fbs.className = 'hint-line yt-creds-status'; } }
  } catch {}
  try {
    const g = state.config.google || {};
    $('gClientId').value = g.clientId || '';
    if ($('gClientSecret')) $('gClientSecret').value = g.clientSecretMasked || '';
    const gb = $('connectGAgent'); if (gb) gb.disabled = !g.hasCredentials || !!g.hasToken;
    if (gs) { if (g.hasToken) { gs.textContent = g.email ? '✓ Connected ('+g.email+')' : '✓ Connected'; gs.className = 'hint-line yt-creds-status ok'; } else if (g.hasCredentials) { gs.textContent = 'Credentials saved — press Connect Agent'; gs.className = 'hint-line yt-creds-status'; } else { gs.textContent = 'Add Client ID & Secret, save keys'; gs.className = 'hint-line yt-creds-status'; } }
  } catch {}
}

function showWorkDir() {
  const wd = state.workDir || '';
  $('workDir').textContent = wd;
  $('filesTitle').textContent = 'Channel files' + (wd ? ' · ' + wd.split(/[\\/]/).filter(Boolean).pop() : '');
}

async function saveConfigNow() {
  const patch = { endpoint: $('endpoint').value.trim(), model: state.model, agent: $('agent').value };
  state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  setStatus('saved', 'ok');
}

/* ---------- models + custom dropdown (msel) ---------- */

let modelRetryTimer = null;

function setModelsBusy(busy, label) {
  document.body.classList.toggle('busy-models', busy);
  $('endpointSpin').hidden = !busy;
  $('endpoint').setAttribute('aria-busy', busy ? 'true' : 'false');
  $('refreshModels').disabled = busy;
  $('refreshModels').classList.toggle('spinning', busy);
  $('modelBtn').disabled = busy;
  $('modelLabel').textContent = label != null ? label : (state.model || '…');
}

function mselOpen(open) {
  const menu = $('modelMenu');
  const btn = $('modelBtn');
  const want = open == null ? menu.hidden : open;
  menu.hidden = !want;
  btn.setAttribute('aria-expanded', want ? 'true' : 'false');
  $('modelSel').classList.toggle('open', want);
  if (want) {
    // keep the menu inside the viewport: flip upward when there is no room below
    const r = btn.getBoundingClientRect();
    const roomBelow = window.innerHeight - r.bottom;
    menu.classList.toggle('up', roomBelow < 260 && r.top > roomBelow);
    const sel = menu.querySelector('.msel-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

function renderModelMenu() {
  const menu = $('modelMenu');
  menu.innerHTML = '';
  if (!state.modelOptions.length) {
    const li = document.createElement('li');
    li.className = 'msel-empty';
    li.textContent = 'no models';
    menu.appendChild(li);
    return;
  }
  let lastProvider = null;
  for (const m of state.modelOptions) {
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      const h = document.createElement('li');
      h.className = 'msel-group';
      h.textContent = m.provider + (m.providerType === 'openai' ? ' (OpenAI-compatible)' : m.providerType === 'anthropic' ? ' (Anthropic)' : ' (Ollama)');
      menu.appendChild(h);
    }
    const li = document.createElement('li');
    li.className = 'msel-item' + (m.ref === state.model ? ' sel' : '') + (m.error ? ' bad' : '');
    li.setAttribute('role', 'option');
    li.textContent = m.error ? '⚠ ' + m.error.slice(0, 60) : m.name + (m.parameterSize ? ` (${m.parameterSize})` : '');
    if (m.error) { li.title = m.error; li.classList.add('disabled'); }
    else {
      li.title = m.ref;
      li.addEventListener('click', () => {
        state.model = m.ref;
        $('modelLabel').textContent = m.name;
        mselOpen(false);
        setStatus('model: ' + m.ref, 'ok');
      });
    }
    menu.appendChild(li);
  }
}

async function loadModels({ autoRetry = true } = {}) {
  clearTimeout(modelRetryTimer);
  setModelsBusy(true, 'Loading models…');
  setStatus('connecting…', 'busy');
  const providerIds = ['default', ...Object.keys(state.config.providers || {})];
  const settled = await Promise.allSettled(providerIds.map((id) =>
    api('/api/models?provider=' + encodeURIComponent(id), { timeoutMs: 45000, retry: false })));
  const options = [];
  let anyError = null;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const pid = providerIds[i];
    if (r.status === 'rejected') { anyError = r.reason; options.push({ ref: '', name: '⚠ ' + String(r.reason.message).slice(0, 70), provider: pid, error: String(r.reason.message) }); continue; }
    const provider = r.value.provider || { id: pid, type: 'ollama' };
    for (const m of (r.value.models || [])) {
      const name = m.name || m.id;
      options.push({
        ref: provider.id === 'default' ? name : `${provider.id}/${name}`,
        name,
        provider: provider.id,
        providerType: provider.type,
        parameterSize: m.parameter_size || (m.size ? Math.round(m.size / 1e9) + 'B' : ''),
        error: m.error,
      });
    }
  }
  state.modelOptions = options;
  const refs = options.filter((m) => m.ref && !m.error).map((m) => m.ref);
  if (!refs.length) {
    setModelsBusy(false, '⚠ ' + (anyError ? truncate(anyError.message, 40) : 'no models'));
    setStatus(anyError ? 'cannot connect' : 'no models', 'err');
    renderModelMenu();
    if (autoRetry) modelRetryTimer = setTimeout(() => loadModels({ autoRetry: true }), 10000);
    return false;
  }
  const want = refs.includes(state.model) ? state.model : refs.includes('default/' + state.model) ? 'default/' + state.model : refs[0];
  state.model = want;
  const chosen = options.find((m) => m.ref === want);
  setModelsBusy(false, chosen ? chosen.name : want);
  renderModelMenu();
  const failed = options.filter((m) => m.error);
  setStatus('ready', 'ok');
  $('connStatus').title = failed.length ? failed.map((f) => `${f.provider}: ${f.error}`).join('\n') : '';
  return true;
}

/* ---------- agents ---------- */

function fillAgents(list, selected) {
  state.agents = list;
  const sel = $('agent');
  sel.innerHTML = '';
  for (const a of list) {
    if (a.subagent) continue;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = (a.label || a.id) + (a.voice ? '' : ' (no voice.md)');
    o.title = a.id === 'create' ? 'Full Studio agent — writes, uploads, publishes' : a.id === 'analyze' ? 'Read-only analysis' : '';
    sel.appendChild(o);
  }
  const want = selected || state.config.agent || 'create';
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}

/* ---------- sessions ---------- */

async function loadSessions() {
  const { sessions } = await api('/api/sessions?archived=' + (state.archivedView ? '1' : '0'));
  state.sessions = sessions;
  const list = $('sessionList');
  list.innerHTML = '';
  $('archivedBtn').classList.toggle('primary', state.archivedView);
  if (!sessions.length) {
    const li = document.createElement('li');
    li.style.cssText = 'cursor:default;color:var(--faint)';
    li.innerHTML = state.archivedView ? 'No archived sessions.' : 'No sessions yet.<br>Send a message to start one.';
    list.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = s.id === state.sessionId ? 'active' : '';
    li.innerHTML =
      `<span class="t">${escapeHtml(s.title || 'Untitled')}</span>` +
      `<span class="meta"><span class="badge">${escapeHtml(s.agent || 'create')}</span><span>${ago(s.updatedAt)} ago</span><span>${s.messages} msgs</span>` +
      `<span class="del" title="Delete" style="margin-left:auto;cursor:pointer">✕</span></span>`;
    li.addEventListener('click', () => openSession(s.id));
    li.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${s.title}"?`)) return;
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      if (state.sessionId === s.id) newSession();
      loadSessions();
    });
    list.appendChild(li);
  }
}

function newSession() {
  state.sessionId = null;
  state.messages = [];
  $('metricsBadge').hidden = true;
  $('messages').innerHTML = '';
  renderTodos([]);
  addHint();
  loadSessions();
}

function addHint() {
  const d = document.createElement('div');
  d.className = 'notice';
  d.innerHTML = 'Working in <em>' + escapeHtml(state.workDir || '…') + '</em> — ask the agent to research, script, package, render or publish. ' +
    'The <b>create</b> agent is a full YouTube Studio agent: it can upload (yt_upload), set visibility (yt_set_visibility) and read stats once the channel is connected in Providers.';
  $('messages').appendChild(d);
}

async function openSession(id) {
  if (state.streaming) return;
  const s = await api(`/api/sessions/${id}`);
  state.sessionId = s.id;
  if ([...$('agent').options].some((o) => o.value === s.agent)) $('agent').value = s.agent;
  renderSession(s);
  renderTodos(s.todos || []);
  try { localStorage.setItem('lastSession', s.id); } catch { /* ignore */ }
  await loadSessions();
}

const RENDER_WINDOW = 80;

function renderSession(s, from = null) {
  const box = $('messages');
  const all = s.messages || [];
  state.messages = all;
  const start = from == null ? Math.max(0, all.length - RENDER_WINDOW) : Math.max(0, from);
  box.replaceChildren();
  bulkRender = true;
  try {
    if (start > 0) {
      const more = document.createElement('button');
      more.className = 'btn small ghost';
      more.style.alignSelf = 'flex-start';
      more.textContent = `↑ Show ${Math.min(RENDER_WINDOW, start)} earlier messages (${start} hidden)`;
      more.addEventListener('click', () => { const keep = box.scrollHeight - box.scrollTop; renderSession(s, start - RENDER_WINDOW); box.scrollTop = box.scrollHeight - keep; });
      box.appendChild(more);
    }
    const cards = new Map();
    for (let i = start; i < all.length; i++) {
      try { renderOneMessage(all[i], i, cards); } catch (e) { console.error('could not draw message', i, e); }
    }
    if (!all.length) addHint();
  } finally { bulkRender = false; }
  scrollChat();
}

function renderOneMessage(m, i, cards) {
  if (m.role === 'user') {
    const el = addMessage('user', m.content || '');
    el.dataset.idx = i;
  } else if (m.role === 'assistant') {
    if (m.thinking) { const t = addThinkingBlock(); t.open = false; setThinking(t, m.thinking); }
    if (m.content) { const el = addMessage('assistant', m.content); el.dataset.idx = i; }
    for (const tc of m.toolCalls || []) {
      let args = tc.function && tc.function.arguments;
      try { args = typeof args === 'string' ? JSON.parse(args) : args; } catch { /* keep raw */ }
      const { card, body } = addToolCard(tc.function && tc.function.name, args);
      body.innerHTML = `<pre>${escapeHtml(truncate(typeof (tc.function && tc.function.arguments) === 'string' ? tc.function.arguments : JSON.stringify(args, null, 2), 6000))}</pre>`;
      cards.set(tc.id, { card, body });
    }
  } else if (m.role === 'tool') {
    const c = cards.get(m.toolCallId);
    if (!c) return;
    const raw = String(m.content || '');
    let parsed = raw;
    let ok = !m.error;
    if (raw.length <= 30000) { try { parsed = JSON.parse(raw); ok = ok && !(parsed && parsed.error); } catch { /* text */ } }
    else parsed = raw.slice(0, 1200) + `… (${(raw.length - 1200).toLocaleString()} more characters)`;
    c.body.innerHTML += resultHtml(parsed, ok);
    c.card.classList.add(ok ? 'ok' : 'err');
  }
}

function renderTodos(todos) {
  const el = $('todos');
  el.hidden = !todos.length;
  el.innerHTML = todos.map((t) => {
    const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
    return `<div class="todo ${t.status}"><span class="st">${mark}</span><span>${escapeHtml(t.content)}</span></div>`;
  }).join('');
}

/* ---------- files ---------- */

const treeState = { expanded: new Set(), cache: new Map() }; // rel path -> [{path,type,size}]

async function fetchDir(rel) {
  const d = await api('/api/files?path=' + encodeURIComponent(rel || '.'));
  treeState.cache.set(rel || '.', d.files || []);
  return treeState.cache.get(rel || '.');
}

async function loadTree() {
  const dirs = ['.', ...treeState.expanded];
  await Promise.all(dirs.map((d) => fetchDir(d).catch((e) => { if (d !== '.') treeState.expanded.delete(d); else throw e; })));
  renderTree();
}

function baseName(p) { return String(p).replace(/\/$/, '').split('/').pop(); }

function renderTree() {
  const ul = $('tree');
  const frag = document.createDocumentFragment();
  const root = treeState.cache.get('.');
  if (!root || !root.length) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:8px;color:var(--faint);cursor:default';
    li.textContent = 'Empty directory.';
    frag.appendChild(li);
  } else {
    walkLevel(frag, '.', 0);
  }
  ul.replaceChildren(frag);
}

function walkLevel(frag, rel, depth) {
  const level = treeState.cache.get(rel);
  if (!level) return;
  for (const node of level) {
    const li = document.createElement('li');
    const isDir = node.type === 'dir' || String(node.path).endsWith('/');
    const p = String(node.path).replace(/\/$/, '');
    if (isDir) {
      const open = treeState.expanded.has(p);
      li.className = 'entry dir';
      li.innerHTML = `<span class="caret">${open ? '▾' : '▸'}</span><span class="ico">📁</span><span>${escapeHtml(baseName(p))}/</span>`;
      li.title = p;
      li.addEventListener('click', () => toggleDir(p));
      frag.appendChild(li);
      if (open) {
        const ul = document.createElement('ul');
        ul.style.paddingLeft = '14px';
        walkLevel(ul, p, depth + 1);
        li.appendChild(ul);
      }
    } else {
      li.className = 'entry file' + (p === state.activeFile ? ' active' : '');
      li.dataset.path = p;
      li.innerHTML = `<span class="caret"></span><span class="ico">📄</span><span>${escapeHtml(baseName(p))}</span>` + (node.size != null ? `<span class="sz">${fmtSize(node.size)}</span>` : '');
      li.title = p;
      li.addEventListener('click', () => openFile(p).catch((e) => setStatus(e.message, 'err')));
      frag.appendChild(li);
    }
  }
}

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

async function toggleDir(rel) {
  try {
    if (treeState.expanded.has(rel)) treeState.expanded.delete(rel);
    else { treeState.expanded.add(rel); if (!treeState.cache.has(rel)) await fetchDir(rel); }
    renderTree();
  } catch (e) { treeState.expanded.delete(rel); setStatus('cannot open folder: ' + e.message, 'err'); }
}

function markActiveFile() {
  document.querySelectorAll('#tree .entry.file').forEach((li) => li.classList.toggle('active', li.dataset.path === state.activeFile));
}

async function openFile(relPath) {
  const data = await api(`/api/file?path=${encodeURIComponent(relPath)}`);
  state.activeFile = relPath;
  $('editor').value = data.content;
  $('editorTitle').textContent = relPath;
  $('saveFile').disabled = false;
  setDirty(false);
  markActiveFile();
  openEditorModal();
  if (isMobile()) closeDrawer();
}

async function saveFile() {
  if (!state.activeFile) return;
  await api('/api/file', { method: 'POST', body: JSON.stringify({ path: state.activeFile, content: $('editor').value }) });
  setDirty(false);
  setStatus('file saved', 'ok');
}

async function createFile() {
  const p = prompt('New file path (e.g. scripts/ep-01.md):');
  if (!p) return;
  await api('/api/file', { method: 'POST', body: JSON.stringify({ path: p, content: '' }) });
  await loadTree();
  await openFile(p);
}

const setDirty = (on) => { $('dirtyDot').className = 'dirty' + (on ? ' on' : ''); };

/* ---------- chat rendering ---------- */

function resultHtml(result, ok) {
  const color = ok ? 'var(--ok)' : 'var(--err)';
  let html = '';
  if (result && typeof result.diff === 'string') {
    html += '<div class="diff">' + escapeHtml(truncate(result.diff, 40000)).split('\n').slice(0, 800).map((l) =>
      `<div class="${l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : 'hunk'}">${escapeHtml(l)}</div>`).join('') + '</div>';
    const { diff, ...rest } = result;
    result = rest;
  }
  return html + `<pre style="margin-top:6px;color:${color}">→ ${escapeHtml(truncate(JSON.stringify(result, null, 2), 1200))}</pre>`;
}

function setMessageText(el, text) {
  el.dataset.raw = text;
  // `el` may be the .msg container (streaming) or the inner .body (history).
  // Render markdown into the .body so the role label survives. Uses a direct
  // reference (set in addMessage) with fallbacks for browsers lacking :scope.
  let body = el;
  if (!el.classList.contains('body')) {
    body = el._body || el.querySelector(':scope > .body') || Array.prototype.find.call(el.children, (c) => c.classList.contains('body')) || el;
  }
  if (el.classList.contains('assistant') || body.classList.contains('assistant')) body.innerHTML = window.renderMarkdown(text);
  else body.textContent = text;
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.innerHTML = `<span>${role === 'user' ? 'you' : role}</span><span class="edit-hint" title="Copy / edit">✎</span>`;
  const body = document.createElement('div');
  body.className = 'body';
  if (role === 'assistant') body.classList.add('assistant');
  div._body = body;
  div.append(roleEl, body);
  setMessageText(body, text);
  roleEl.querySelector('.edit-hint').addEventListener('click', (e) => { e.stopPropagation(); openMsgMenu(div, e.clientX, e.clientY); });
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

function addThinkingBlock() {
  const el = document.createElement('details');
  el.className = 'msg thinking';
  el.open = true;
  el.innerHTML = '<summary>💭 Thinking</summary><div class="tbody"></div>';
  $('messages').appendChild(el);
  return el;
}
const setThinking = (el, text) => { el.querySelector('.tbody').textContent = text; };

function addErrorBubble(message) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.innerHTML = `<div class="role"><span>error</span></div><div class="body">✖ ${escapeHtml(String(message || 'unknown error'))}</div>`;
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

const pendingRender = new Map();
const lastRender = new WeakMap();
function renderSoon(el, text) {
  const had = pendingRender.has(el);
  pendingRender.set(el, text);
  if (had) return;
  const wait = Math.max(0, (text.length > 20000 ? 700 : text.length > 6000 ? 350 : text.length > 2000 ? 120 : 0) - (Date.now() - (lastRender.get(el) || 0)));
  const run = () => requestAnimationFrame(() => {
    const t = pendingRender.get(el);
    pendingRender.delete(el);
    lastRender.set(el, Date.now());
    try { setMessageText(el, t); } catch (e) { console.error('markdown render failed', e); el.textContent = t; }
    scrollChat();
  });
  if (wait > 0) setTimeout(run, wait); else run();
}

const pendingThink = new Map();
function thinkSoon(el, text) {
  const had = pendingThink.has(el);
  pendingThink.set(el, text);
  if (had) return;
  setTimeout(() => { const t = pendingThink.get(el); pendingThink.delete(el); setThinking(el, t.length > 30000 ? '…' + t.slice(-30000) : t); scrollChat(); }, 120);
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return [args.path, args.command, args.pattern, args.query, args.topic, args.title, args.videoPath, args.videoId, args.name].filter(Boolean).map((x) => truncate(String(x), 50)).join(' · ');
}

function addToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tcard';
  const head = document.createElement('div');
  head.className = 'thead';
  head.innerHTML = `<span class="name">⚙ ${escapeHtml(name || 'tool')}</span><span class="args">${escapeHtml(summarizeArgs(args))}</span><span class="st">…</span>`;
  const body = document.createElement('div');
  body.className = 'tbody';
  head.addEventListener('click', () => card.classList.toggle('open'));
  card.append(head, body);
  $('messages').appendChild(card);
  scrollChat();
  return { card, body };
}

function addPermissionCard(ev) {
  const div = document.createElement('div');
  div.className = 'pcard';
  div.innerHTML = `<div class="label">Permission needed — ${escapeHtml(ev.category || 'tool')}</div>` +
    `<div class="subject">the agent wants to run <b>${escapeHtml(ev.label || ev.name || '')}</b>: ${escapeHtml(ev.subject || '')}</div>` +
    (ev.reason ? `<div class="hint-line">${escapeHtml(ev.reason)}</div>` : '') +
    '<div class="row"><button class="btn small primary" data-r="once">Allow once</button>' +
    '<button class="btn small" data-r="allow">Always allow</button>' +
    '<button class="btn small ghost" data-r="deny">Reject</button></div>';
  div.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    div.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    div.classList.add('done');
    try { await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: ev.id, answer: b.dataset.r }) }); }
    catch (err) { addErrorBubble(err.message); }
  }));
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

function addQuestionCard(ev) {
  const div = document.createElement('div');
  div.className = 'pcard';
  div.innerHTML = `<div class="label">Question</div><div style="margin:4px 0">${escapeHtml(ev.question)}</div><div class="row"></div>`;
  const row = div.querySelector('.row');
  const send = async (answer) => {
    div.classList.add('done');
    div.querySelectorAll('button,input').forEach((x) => { x.disabled = true; });
    try { await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: ev.id, answer }) }); }
    catch (err) { addErrorBubble(err.message); }
  };
  for (const o of ev.options || []) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = o;
    b.addEventListener('click', () => send(o));
    row.appendChild(b);
  }
  const input = document.createElement('input');
  input.placeholder = 'Type your own answer…';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) send(input.value.trim()); });
  row.appendChild(input);
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

function addNote(text) {
  const d = document.createElement('div');
  d.className = 'notice';
  d.textContent = text;
  $('messages').appendChild(d);
  scrollChat();
  return d;
}

/* ---------- SSE run streaming ---------- */

async function consumeRun(res) {
  let assistantEl = null;
  let assistantText = '';
  let thinkingEl = null;
  let thinkingText = '';
  const toolCards = new Map();
  const cards = new Map();
  let finished = false;
  let touchedFiles = false;

  const newTurnBlock = () => { assistantEl = null; assistantText = ''; thinkingEl = null; thinkingText = ''; };

  const handle = (event, data) => {
    switch (event) {
      case 'start':
        state.sessionId = data.sessionId;
        setStatus(`${data.agent} · generating…`, 'generating');
        break;
      case 'iteration': newTurnBlock(); break;
      case 'thinking':
        thinkingText += data.text || '';
        if (thinkingText.trim()) {
          if (!thinkingEl) thinkingEl = addThinkingBlock();
          thinkingEl.style.display = '';
          thinkSoon(thinkingEl, thinkingText);
        }
        break;
      case 'token':
        if (!assistantEl) { assistantEl = addMessage('assistant', ''); if (thinkingEl) thinkingEl.open = false; }
        assistantText += data.text || '';
        renderSoon(assistantEl, assistantText);
        break;
      case 'tool_call': {
        const { card, body } = addToolCard(data.name, data.args);
        body.innerHTML = `<pre>${escapeHtml(JSON.stringify(data.args, null, 2))}</pre>`;
        toolCards.set(data.id, { card, body });
        break;
      }
      case 'tool_result': {
        const c = toolCards.get(data.id);
        if (c) {
          let parsed = data.content;
          let ok = !data.error;
          if (typeof parsed === 'string') {
            if (parsed.length <= 30000) { try { parsed = JSON.parse(parsed); ok = ok && !(parsed && parsed.error); } catch { /* text */ } }
            else parsed = parsed.slice(0, 1200) + `… (${(parsed.length - 1200).toLocaleString()} more characters)`;
          }
          c.body.innerHTML += resultHtml(parsed, ok);
          c.card.classList.add(ok ? 'ok' : 'err');
          c.card.classList.toggle('open', !ok);
          const st = c.card.querySelector('.st');
          if (st) { st.textContent = ok ? '✓' : '✗'; st.className = 'st ' + (ok ? 'ok' : 'err'); }
        }
        if (/write_file|edit_file|delete_file|bash|yt_upload|yt_set_visibility/.test(data.name || '')) touchedFiles = true;
        break;
      }
      case 'subagent':
        if (data.status === 'start') addNote(`◇ subagent "${data.agent}" started${data.description ? ': ' + data.description : ''}`);
        else if (data.status === 'error') addNote(`◇ subagent "${data.agent}" failed: ${data.error}`);
        break;
      case 'todos': renderTodos(data.todos || []); break;
      case 'question': cards.set(data.id, addQuestionCard(data)); break;
      case 'permission_request': cards.set(data.id, addPermissionCard(data)); break;
      case 'title': loadSessions(); break;
      case 'agent': {
        const name = data.name || data.command;
        if (name && [...$('agent').options].some((o) => o.value === name)) { $('agent').value = name; addNote(`◇ switched to the "${name}" agent`); }
        break;
      }
      case 'retry':
        if (assistantEl) { assistantEl.remove(); newTurnBlock(); }
        addNote(`server error — retry ${data.attempt || 1} (${data.reason || data.message || ''})`);
        setStatus('retrying…', 'busy');
        break;
      case 'compacting': addNote('context is full — summarising older messages…'); break;
      case 'metrics':
        if (data && (data.iterations || data.elapsedMs)) showMetricsBadge(data);
        break;
      case 'warning': addNote('⚠ ' + (data.message || '')); break;
      case 'error': addErrorBubble(data.message || 'unknown error'); setStatus('error', 'err'); finished = true; break;
      case 'aborted': addNote('■ stopped — the work done so far is saved; send "continue" to resume.'); setStatus('stopped', ''); finished = true; break;
      case 'done':
        setStatus('done', 'ok');
        if (data && data.metrics) showMetricsBadge(data.metrics);
        finished = true;
        break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let curEvent = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let dataLine = '';
      curEvent = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith(':')) continue;                       // keepalive comment
        if (line.startsWith('event: ')) curEvent = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine) continue;
      let data = null;
      try { data = JSON.parse(dataLine); } catch (e) { console.warn('bad event from the server', e); continue; }
      if (!curEvent && data && data.type) curEvent = data.type;
      try { handle(curEvent, data); } catch (e) { console.error('could not show event', curEvent, e); }
    }
  }
  if (touchedFiles) loadTree().catch((e) => console.warn('file tree refresh failed', e));
  return finished;
}

async function startRun(message) {
  if (state.streaming) return;
  if (!state.sessionId) {
    const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: message.slice(0, 60), agent: $('agent').value }) });
    state.sessionId = s.id;
    await loadSessions();
  }
  await api(`/api/sessions/${state.sessionId}/agent`, { method: 'POST', body: JSON.stringify({ agent: $('agent').value }) }).catch(() => {});
  state.streaming = true;
  state.abortController = new AbortController();
  $('send').textContent = 'Stop';
  let finished = false;
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abortController.signal,
      body: JSON.stringify(message != null ? { message } : {}),
    });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    finished = await consumeRun(res);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (state.userStopped) { finished = true; setStatus('stopped', ''); }
      else { addNote('⚠ connection lost — refreshing session…'); finished = true; }
    } else {
      addErrorBubble(err.message);
      setStatus('error', 'err');
      finished = true;
    }
  } finally {
    state.streaming = false;
    state.abortController = null;
    $('send').textContent = 'Send';
  }
  await loadSessions();
  if (finished && state.sessionId) {
    try { await openSession(state.sessionId); } catch (e) { console.warn('could not refresh the session after the run', e); }
  }
}

function stopRun() {
  state.userStopped = true;
  setStatus('stopping…', 'busy');
  if (state.abortController) state.abortController.abort();
}

/* ---------- auto-forge (one-click end-to-end workflow) ---------- */

const AF_STEP_IDS = ['idea', 'script', 'voice', 'footage', 'render', 'thumbnail', 'upload'];

function afShowPanel(idea) {
  const panel = $('autoforgePanel');
  panel.hidden = false;
  $('autoforgeIdea').textContent = idea ? '· ' + idea : '';
  const ol = $('autoforgeSteps');
  ol.innerHTML = '';
  AF_STEP_IDS.forEach((id, i) => {
    const li = document.createElement('li');
    li.className = 'af-step';
    li.dataset.id = id;
    li.innerHTML = `<span class="af-dot"></span><span class="af-num">${i + 1}/${AF_STEP_IDS.length}</span><span class="af-label"></span><span class="af-detail"></span>`;
    ol.appendChild(li);
  });
}

function afSetStep(step, id, status, detail) {
  const li = $('autoforgeSteps').querySelector(`.af-step[data-id="${id}"]`);
  if (!li) return;
  li.className = 'af-step ' + (status || '');
  const d = li.querySelector('.af-detail');
  if (detail != null) d.textContent = detail;
}

function afHandle(ev) {
  if (ev.id === 'start') { afShowPanel(ev.idea); setStatus('auto-forge: starting…', 'generating'); return; }
  if (ev.id === 'done') {
    setStatus(ev.uploaded ? 'auto-forge: uploaded ✓' : 'auto-forge: finished', ev.uploaded ? 'ok' : '');
    return;
  }
  if (ev.status === 'start') {
    const li = $('autoforgeSteps').querySelector(`.af-step[data-id="${ev.id}"]`);
    if (li) { li.querySelector('.af-label').dataset.label = ev.label; li.querySelector('.af-label').textContent = `Step ${ev.step}/${ev.total}: ${ev.label}`; }
    setStatus(`auto-forge: ${ev.label}…`, 'generating');
    return;
  }
  afSetStep(ev.step, ev.id, ev.status, ev.detail || (ev.status === 'error' ? 'Error: ' + (ev.error || 'failed') : ''));
  if (ev.status === 'error') setStatus(`auto-forge: error in step ${ev.step} (${ev.label})`, 'err');
  else if (ev.status === 'skipped') addNote(`⚠ Auto-Forge step ${ev.step} (${ev.label}) used a placeholder`);
}

async function startAutoForge(idea) {
  if (state.streaming) { addNote('⚠ a run is already in progress'); return; }
  state.streaming = true;
  state.abortController = new AbortController();
  const prevSend = $('send').textContent;
  $('send').textContent = 'Stop';
  let finished = false;
  try {
    const res = await fetch('/api/workflow/autoforge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abortController.signal,
      body: JSON.stringify({ idea }),
    });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    finished = await consumeAutoForge(res);
  } catch (err) {
    if (err.name === 'AbortError') { addNote('■ Auto-Forge stopped.'); setStatus('auto-forge stopped', ''); }
    else { addErrorBubble(err.message); setStatus('auto-forge: error', 'err'); }
    finished = true;
  } finally {
    state.streaming = false;
    state.abortController = null;
    $('send').textContent = prevSend;
  }
  if (finished) loadTree().catch(() => {});
}

async function consumeAutoForge(res) {
  const cards = new Map();
  let finished = false;
  const handle = (event, data) => {
    switch (event) {
      case 'autoforge': afHandle(data); break;
      case 'token': {
        // append streamed script text into a live note so the user sees progress
        let el = document.getElementById('afStream');
        if (!el) { el = addNote(''); el.id = 'afStream'; el.classList.add('af-stream'); }
        el.textContent = (el.textContent + (data.text || '')).slice(-4000);
        break;
      }
      case 'thinking': break;
      case 'question': cards.set(data.id, addQuestionCard(data)); break;
      case 'permission_request': cards.set(data.id, addPermissionCard(data)); break;
      case 'tool_call': addNote(`◇ ${data.name}`); break;
      case 'warning': addNote('⚠ ' + (data.message || '')); break;
      case 'error': addErrorBubble(data.message || 'unknown error'); setStatus('auto-forge: error', 'err'); break;
      case 'done': finished = true; break;
    }
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let curEvent = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let dataLine = '';
      curEvent = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) curEvent = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine) continue;
      let data = null;
      try { data = JSON.parse(dataLine); } catch { continue; }
      try { handle(curEvent, data); } catch (e) { console.error('could not show autoforge event', curEvent, e); }
    }
  }
  return finished;
}

function promptAutoForge() {
  const panel = $('autoforgePanel');
  if (!panel.hidden) { panel.hidden = true; return; }
  const idea = window.prompt('What should Auto-Forge make today?\n\nGive it a topic or a working idea, e.g. "5 fixes for a channel stuck under 500 views".');
  if (!idea || !idea.trim()) return;
  addMessage('user', '🚀 Auto-Forge: ' + idea.trim());
  startAutoForge(idea.trim());
}

/* ---------- providers dialog ---------- */

const PRESETS = {
  openai: { id: 'openai', type: 'openai', endpoint: 'https://api.openai.com/v1' },
  anthropic: { id: 'anthropic', type: 'anthropic', endpoint: 'https://api.anthropic.com' },
  gemini: { id: 'gemini', type: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  groq: { id: 'groq', type: 'openai', endpoint: 'https://api.groq.com/openai/v1' },
  openrouter: { id: 'openrouter', type: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  ollama: { id: 'ollama2', type: 'ollama', endpoint: 'http://localhost:11434' },
};

function providerRowHtml(id, p, isDefault) {
  const t = p.type === 'openai' || p.type === 'anthropic' ? p.type : 'ollama';
  const opt = (v, label) => `<option value="${v}" ${t === v ? 'selected' : ''}>${label}</option>`;
  return `<div class="prow" data-id="${escapeHtml(id)}">
    ${isDefault ? '' : `<label>Preset</label><select data-f="preset"><option value="">Custom…</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic (Claude)</option><option value="gemini">Google Gemini</option><option value="groq">Groq</option><option value="openrouter">OpenRouter</option><option value="ollama">Another Ollama</option></select>`}
    <label>Name</label><input data-f="id" value="${escapeHtml(id)}" ${isDefault ? 'disabled' : ''} placeholder="e.g. openai, groq, gemini" />
    <label>Type</label><select data-f="type" ${isDefault ? 'disabled' : ''}>${opt('ollama', 'Ollama')}${opt('openai', 'OpenAI-compatible (OpenAI, Groq, Gemini…)')}${opt('anthropic', 'Anthropic (Claude)')}</select>
    <label>Endpoint</label><input data-f="endpoint" value="${escapeHtml(p.endpoint || '')}" placeholder="http://localhost:11434  |  https://api.openai.com/v1" spellcheck="false" />
    <label>API key</label><input data-f="apiKey" type="password" value="${escapeHtml(p.apiKey || '')}" placeholder="${isDefault ? '(optional — not needed for plain Ollama)' : '(optional for Ollama, required for cloud APIs)'}" autocomplete="off" />
    ${isDefault ? '' : `<label>Context window</label><input data-f="contextWindow" type="number" value="${p.contextWindow || ''}" placeholder="auto" />`}
    <div class="full"><button class="btn small" data-act="test" type="button">Test</button>${isDefault ? '' : '<button class="btn small ghost" data-act="remove" type="button">Remove</button>'}<span class="res"></span></div>
  </div>`;
}

function openProviders() {
  const c = state.config;
  $('providerRows').innerHTML = providerRowHtml('default', { type: 'ollama', endpoint: c.endpoint, apiKey: c.apiKey }, true) +
    Object.entries(c.providers || {}).map(([id, p]) => providerRowHtml(id, p, false)).join('');
  bindProviderRows();
  fillYtCreds(c.youtube || {});
  try {
    const ig = c.instagram || {};
    $('igClientId').value = ig.clientId || '';
    if ($('igClientSecret')) $('igClientSecret').value = ig.clientSecretMasked || '';
    const igs = $('igAuthStatus');
    const igb = $('connectIgAgent'); if (igb) igb.disabled = !ig.hasCredentials || !!ig.hasToken;
    if (igs) { if (ig.hasToken) { igs.textContent = ig.username ? '✓ Connected (@'+ig.username+')' : '✓ Connected'; igs.className = 'hint-line yt-creds-status ok'; } else if (ig.hasCredentials) { igs.textContent = 'Credentials saved — press Connect Agent'; igs.className = 'hint-line yt-creds-status'; } else { igs.textContent = 'Add Client ID & Secret, save keys'; igs.className = 'hint-line yt-creds-status'; } }
  } catch {}
  try {
    const fb = c.facebook || {};
    $('fbClientId').value = fb.clientId || '';
    if ($('fbClientSecret')) $('fbClientSecret').value = fb.clientSecretMasked || '';
    const fbb = $('connectFbAgent'); if (fbb) fbb.disabled = !fb.hasCredentials || !!fb.hasToken;
    if (fbs) { if (fb.hasToken) { fbs.textContent = fb.pages && fb.pages.length ? '✓ Connected ('+fb.pages.length+' page'+(fb.pages.length===1?'':'s')+')' : '✓ Connected'; fbs.className = 'hint-line yt-creds-status ok'; } else if (fb.hasCredentials) { fbs.textContent = 'Credentials saved — press Connect Agent'; fbs.className = 'hint-line yt-creds-status'; } else { fbs.textContent = 'Add Client ID & Secret, save keys'; fbs.className = 'hint-line yt-creds-status'; } }
  } catch {}
  try {
    const g = c.google || {};
    $('gClientId').value = g.clientId || '';
    if ($('gClientSecret')) $('gClientSecret').value = g.clientSecretMasked || '';
    const gb = $('connectGAgent'); if (gb) gb.disabled = !g.hasCredentials || !!g.hasToken;
    if (gs) { if (g.hasToken) { gs.textContent = g.email ? '✓ Connected ('+g.email+')' : '✓ Connected'; gs.className = 'hint-line yt-creds-status ok'; } else if (g.hasCredentials) { gs.textContent = 'Credentials saved — press Connect Agent'; gs.className = 'hint-line yt-creds-status'; } else { gs.textContent = 'Add Client ID & Secret, save keys'; gs.className = 'hint-line yt-creds-status'; } }
  } catch {}
  refreshYtStatus();
  $('providersDlg').showModal();
}

function readRow(row) {
  const f = (k) => row.querySelector(`[data-f="${k}"]`);
  return { id: f('id').value.trim(), type: f('type').value, endpoint: f('endpoint').value.trim(), apiKey: f('apiKey') ? f('apiKey').value : undefined, contextWindow: f('contextWindow') && f('contextWindow').value ? Number(f('contextWindow').value) : undefined };
}

function bindProviderRows() {
  $('providerRows').querySelectorAll('.prow').forEach((row) => {
    const preset = row.querySelector('[data-f="preset"]');
    if (preset) preset.addEventListener('change', () => {
      const pr = PRESETS[preset.value];
      if (!pr) return;
      const set = (k, v) => { const el = row.querySelector(`[data-f="${k}"]`); if (el) el.value = v; };
      if (!row.querySelector('[data-f="id"]').value.trim()) set('id', pr.id);
      set('type', pr.type); set('endpoint', pr.endpoint);
    });
    row.querySelector('[data-act="test"]').addEventListener('click', async () => {
      const r = readRow(row);
      const btn = row.querySelector('[data-act="test"]');
      const out = row.querySelector('.res');
      btn.disabled = true;
      out.textContent = 'testing…';
      out.className = 'res busy';
      try {
        const res = await api('/api/models?provider=' + encodeURIComponent(row.dataset.id === 'default' ? 'default' : r.id), { timeoutMs: 30000, retry: false });
        const names = (res.models || []).slice(0, 4).map((m) => m.name || m.id);
        out.textContent = `✓ ${(res.models || []).length} model(s): ${names.join(', ')}${(res.models || []).length > 4 ? '…' : ''}`;
        out.className = 'res ok';
      } catch (err) { out.textContent = '✗ ' + err.message; out.className = 'res bad'; }
      finally { btn.disabled = false; }
    });
    const rm = row.querySelector('[data-act="remove"]');
    if (rm) rm.addEventListener('click', () => row.remove());
  });
}

async function saveProviders() {
  const rows = [...$('providerRows').querySelectorAll('.prow')];
  const providers = {};
  let endpoint = state.config.endpoint;
  let defaultKey = state.config.apiKey || '';
  for (const row of rows) {
    const r = readRow(row);
    if (row.dataset.id === 'default') { endpoint = r.endpoint || endpoint; defaultKey = r.apiKey || ''; continue; }
    if (!r.id || !r.endpoint) continue;
    providers[r.id] = { type: r.type, endpoint: r.endpoint, ...(r.apiKey ? { apiKey: r.apiKey } : {}), ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}) };
  }
  state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ endpoint, apiKey: defaultKey, providers }) });
  $('endpoint').value = state.config.endpoint || '';
  $('providersDlg').close();
  await loadModels();
}

/* ---------- YouTube credentials + connect ---------- */

function fillYtCreds(yt) {
  $('ytClientId').value = yt.clientId || '';
  $('ytClientSecret').value = yt.clientSecretMasked || '';
  if (yt.hasToken) setYtStatus('✓ agent connected' + (yt.hasCredentials ? '' : ' — but keys were cleared'), 'ok');
  else if (yt.hasCredentials) setYtStatus('keys saved — press Connect Agent to grant full studio scopes', '');
  else setYtStatus('not configured', '');
}

function setYtStatus(text, cls) {
  const el = $('ytAuthStatus');
  el.textContent = text;
  el.className = 'hint-line yt-creds-status' + (cls ? ' ' + cls : '');
}

async function connectIgAgent() {
  const btn = $('connectIgAgent');
  if (btn) btn.disabled = true;
  setIgStatus("opening Meta's consent screen…", 'busy');
  try {
    const clientId = $('igClientId').value.trim();
    const clientSecret = $('igClientSecret').value.trim();
    if (clientId && clientSecret && !(state.config.instagram && state.config.instagram.hasCredentials)) {
      state.config = await api('/api/instagram/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    }
    const r = await api('/api/instagram/connect', { method: 'POST', body: '{}' });
    window.open(r.url, '_blank', 'noopener');
    setIgStatus('approve access in the opened tab, then this panel updates automatically…', 'busy');
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const st = await api('/api/instagram/status');
        if (st.hasToken) {
          clearInterval(poll);
          setIgStatus(`✓ connected${st.username ? ' (@' + st.username + ')' : ''}`, 'ok');
        }
      } catch {}
      if (tries >= 25) { clearInterval(poll); setIgStatus('not connected yet — finish the consent screen', 'bad'); }
    }, 3000);
  } catch (e) {
    setIgStatus('connect failed: ' + e.message, 'bad');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

async function connectFbAgent() {
  const btn = $('connectFbAgent');
  if (btn) btn.disabled = true;
  setFbStatus("opening Meta's consent screen…", 'busy');
  try {
    const clientId = $('fbClientId').value.trim();
    const clientSecret = $('fbClientSecret').value.trim();
    if (clientId && clientSecret && !(state.config.facebook && state.config.facebook.hasCredentials)) {
      state.config = await api('/api/facebook/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    }
    const r = await api('/api/facebook/connect', { method: 'POST', body: '{}' });
    window.open(r.url, '_blank', 'noopener');
    setFbStatus('approve access in the opened tab, then this panel updates automatically…', 'busy');
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const st = await api('/api/facebook/status');
        if (st.hasToken) {
          clearInterval(poll);
          const pages = (st.pages || []).length;
          setFbStatus(`✓ connected${pages ? ' (' + pages + ' page' + (pages===1?'':'s') + ')' : ''}`, 'ok');
        }
      } catch {}
      if (tries >= 25) { clearInterval(poll); setFbStatus('not connected yet — finish the consent screen', 'bad'); }
    }, 3000);
  } catch (e) {
    setFbStatus('connect failed: ' + e.message, 'bad');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

async function connectGAgent() {
  const btn = $('connectGAgent');
  if (btn) btn.disabled = true;
  setGStatus("opening Google's consent screen…", 'busy');
  try {
    const clientId = $('gClientId').value.trim();
    const clientSecret = $('gClientSecret').value.trim();
    if (clientId && clientSecret && !(state.config.google && state.config.google.hasCredentials)) {
      state.config = await api('/api/google/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    }
    const r = await api('/api/google/connect', { method: 'POST', body: '{}' });
    window.open(r.url, '_blank', 'noopener');
    setGStatus('approve access in the opened tab, then this panel updates automatically…', 'busy');
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const st = await api('/api/google/status');
        if (st.hasToken) {
          clearInterval(poll);
          setGStatus(`✓ connected${st.email ? ' (' + st.email + ')' : ''}`, 'ok');
        }
      } catch {}
      if (tries >= 25) { clearInterval(poll); setGStatus('not connected yet — finish the consent screen', 'bad'); }
    }, 3000);
  } catch (e) {
    setGStatus('connect failed: ' + e.message, 'bad');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

function setIgStatus(text, cls) { const el = $('igAuthStatus'); if (el) { el.textContent = text; el.className = 'hint-line yt-creds-status' + (cls ? ' ' + cls : ''); } }
function setFbStatus(text, cls) { const el = $('fbAuthStatus'); if (el) { el.textContent = text; el.className = 'hint-line yt-creds-status' + (cls ? ' ' + cls : ''); } }
function setGStatus(text, cls) { const el = $('gAuthStatus'); if (el) { el.textContent = text; el.className = 'hint-line yt-creds-status' + (cls ? ' ' + cls : ''); } }

async function refreshYtStatus() {
  try {
    const s = await api('/api/youtube/status');
    if (s.hasToken) setYtStatus(`✓ agent connected (${(s.scopes || []).length} scopes, last refresh: ${s.obtainedAt || '—'})`, 'ok');
    else if (s.hasCredentials) setYtStatus('keys saved — press Connect Agent to open Google\'s consent screen', '');
    else setYtStatus('paste your OAuth Client ID & Secret, then Save keys', '');
  } catch (e) { setYtStatus('status unavailable: ' + e.message, 'bad'); }
}

async function saveYtCreds() {
  const clientId = $('ytClientId').value.trim();
  const clientSecret = $('ytClientSecret').value.trim();
  if (!clientId || !clientSecret) { setYtStatus('both Client ID and Client Secret are required', 'bad'); return; }
  try {
    state.config = await api('/api/youtube/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    $('ytClientSecret').value = state.config.youtube ? state.config.youtube.clientSecretMasked : '';
    setYtStatus('✓ keys saved — press Connect Agent to grant full studio scopes', 'ok');
  } catch (e) { setYtStatus('save failed: ' + e.message, 'bad'); }
}

async function connectAgent() {
  const btn = $('connectAgent');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  setYtStatus('opening Google\'s consent screen…', 'busy');
  try {
    const clientId = $('ytClientId').value.trim();
    const clientSecret = $('ytClientSecret').value.trim();
    if (clientId && clientSecret && !(state.config.youtube && state.config.youtube.hasCredentials)) {
      state.config = await api('/api/youtube/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    }
    const r = await api('/api/youtube/connect', { method: 'POST', body: '{}' });
    window.open(r.url, '_blank', 'noopener');
    setYtStatus('approve access in the opened tab, then this panel updates automatically…', 'busy');
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const s = await api('/api/youtube/status');
        if (s.hasToken) {
          clearInterval(poll);
          setYtStatus('✓ agent connected with full studio scopes (upload, publish, manage)', 'ok');
        }
      } catch { /* keep polling */ }
      if (tries >= 20) { clearInterval(poll); setYtStatus('not connected yet — finish the consent screen, or press Connect Agent again', 'bad'); }
    }, 3000);
  } catch (e) {
    setYtStatus('connect failed: ' + e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Agent';
  }
}

/* ---------- YouTube Studio panel ---------- */

function openYtStudio() {
  const panel = $('ytStudioPanel');
  panel.hidden = false;
  panel.classList.remove('collapsed');
}

function closeYtStudio() {
  $('ytStudioPanel').hidden = true;
}

async function launchAutomationBrowser() {
  const btn = $('launchBrowser');
  const status = $('launchBrowserStatus');
  btn.disabled = true;
  status.textContent = 'launching Chromium…';
  try {
    const r = await api('/api/browser/open', { method: 'POST', body: '{}' });
    status.textContent = r && r.ok
      ? '✓ automation window is open — the agent can see and click it'
      : 'could not open: ' + ((r && r.error) || 'unknown error');
  } catch (e) {
    status.textContent = 'could not open: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function toggleCollapseYtStudio() {
  const panel = $('ytStudioPanel');
  const collapsed = panel.classList.toggle('collapsed');
  $('collapseYtStudio').textContent = collapsed ? '+' : '–';
  $('collapseYtStudio').title = collapsed ? 'Expand panel' : 'Collapse panel';
}

/* ---------- tools/skills dialog ---------- */

async function openStatus() {
  $('statusBody').innerHTML = '<div class="hint-line">loading…</div>';
  if (!$('statusDlg').open) $('statusDlg').showModal();
  try {
    const [st, cmds] = await Promise.all([api('/api/skills'), api('/api/commands')]);
    const skills = st.skills || [];
    const commands = cmds.commands || [];
    $('statusBody').innerHTML =
      '<div class="tsection"><h4>Skills</h4><div id="installedSkillsList" class="tlist">' + skillChips(skills) + '</div></div>' +
      '<div class="tsection"><h4>Commands</h4><div class="tlist">' +
      (commands.length ? commands.map((c) => `<span class="tchip" title="${escapeHtml(c.description || '')}"><b>/${escapeHtml(c.name)}</b></span>`).join('') : '<span class="hint-line">none</span>') +
      '</div></div>' +
      '<div class="tsection"><h4>Agents</h4><div class="tlist">' +
      state.agents.map((a) => `<span class="tchip"><b>${escapeHtml(a.id)}</b> ${a.subagent ? 'subagent' : 'primary'}${a.voice ? ' · voice' : ''}</span>`).join('') +
      '</div></div>';
  } catch (err) { $('statusBody').textContent = err.message; }
}

function skillChips(skills) {
  return skills.length
    ? skills.map((s) => `<span class="tchip" title="${escapeHtml(s.description || '')}"><b>${escapeHtml(s.name)}</b></span>`).join('')
    : '<span class="hint-line">none</span>';
}

function skillHubStatus(text, cls = '') {
  const el = $('skillHubStatus');
  if (el) { el.textContent = text; el.className = 'hint-line' + (cls ? ' ' + cls : ''); }
}

function skillRepoHtml(r) {
  return `<div class="skill-row"><div class="skill-row-main"><b>${escapeHtml(r.fullName || r.repo || '')}</b>` +
    `${r.stars != null ? ` <span class="skill-stars">★ ${Number(r.stars).toLocaleString()}</span>` : ''}` +
    `<div class="skill-desc">${escapeHtml(r.description || '')}</div></div>` +
    `<button class="btn small ghost" type="button" data-skill-action="browse" data-source="${escapeHtml(r.fullName || r.url || '')}">Browse</button></div>`;
}

function skillItemHtml(s, source) {
  const installed = (state.installedSkills || []).some((i) => i.id === s.id);
  return `<div class="skill-row"><div class="skill-row-main"><b>${escapeHtml(s.name || s.id)}</b> <span class="skill-id">${escapeHtml(s.id)}</span>` +
    `<div class="skill-desc">${escapeHtml(s.description || s.path || '')}</div></div>` +
    (installed
      ? `<button class="btn small ghost" type="button" data-skill-action="remove" data-id="${escapeHtml(s.id)}">Remove</button>`
      : `<button class="btn small primary" type="button" data-skill-action="install" data-source="${escapeHtml(source)}" data-path="${escapeHtml(s.path || '')}" data-id="${escapeHtml(s.id)}">Install</button>`) +
    '</div>';
}

async function searchGitHubSkills() {
  const q = $('skillQuery').value.trim();
  skillHubStatus(q ? `Searching GitHub for “${q}”…` : 'Loading featured skill repositories…', 'busy');
  const res = await api('/api/skills/discover?q=' + encodeURIComponent(q) + '&limit=12');
  state.installedSkills = res.installed || state.installedSkills || [];
  if (!res.ok) { skillHubStatus(res.error || 'search failed', 'bad'); return; }
  const repos = res.repos || [];
  $('skillResults').innerHTML = repos.length
    ? repos.map(skillRepoHtml).join('')
    : '<div class="hint-line">No repositories found. Try another search.</div>';
  skillHubStatus(`${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} — pick one to browse its skills.`, 'ok');
}

async function browseSkillRepo(source) {
  if (!source) return;
  skillHubStatus(`Reading ${source}…`, 'busy');
  const res = await api('/api/skills/repo?source=' + encodeURIComponent(source));
  if (!res.ok) { skillHubStatus(res.error || 'could not read repository', 'bad'); return; }
  const skills = res.skills || [];
  $('skillResults').innerHTML =
    `<div class="skill-repo-head"><b>${escapeHtml(res.repo || source)}</b> <span class="skill-id">@ ${escapeHtml(res.ref || '')}</span>` +
    (skills.length > 1 ? `<button class="btn small ghost" type="button" data-skill-action="install-all" data-source="${escapeHtml(source)}">Install all</button>` : '') +
    '</div>' +
    (skills.length ? skills.map((s) => skillItemHtml(s, source)).join('') : '<div class="hint-line">No SKILL.md files found.</div>');
  skillHubStatus(`${skills.length} skill${skills.length === 1 ? '' : 's'} found.`, 'ok');
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function clearSkillPreview() {
  const el = $('skillPreview');
  if (el) el.innerHTML = '';
}

function showSkillPreview(res, source, path, id, all) {
  const el = $('skillPreview');
  if (!el) return;
  const files = res.files || [];
  const flags = res.flags || [];
  const fileRows = files.map((f) => `<div class="skill-prev-file"><code>${escapeHtml(f.repoPath || f.path)}</code><span>${formatBytes(f.size)}</span></div>`).join('');
  const flagRows = flags.length
    ? flags.map((f) => `<div class="skill-flag">⚠ <b>${escapeHtml(f.file)}</b> — ${escapeHtml(f.label || f.rule)}${f.excerpt ? `<div class="skill-flag-excerpt">${escapeHtml(f.excerpt)}</div>` : ''}</div>`).join('')
    : '<div class="hint-line">No warning flags.</div>';
  el.innerHTML = `<div class="skill-review">` +
    `<div class="skill-review-head"><b>Review before installing</b> <span class="skill-id">${escapeHtml(res.repo)} @ ${escapeHtml(String(res.sha || '').slice(0, 12))}</span></div>` +
    `<div class="hint-line">Nothing has been written yet. Check the files, flags and full SKILL.md, then confirm this exact commit.</div>` +
    `<div class="tsection"><h4>Files (${files.length})</h4>${fileRows || '<div class="hint-line">none</div>'}</div>` +
    `<div class="tsection"><h4>Warning flags (${flags.length})</h4>${flagRows}</div>` +
    `<div class="tsection"><h4>SKILL.md</h4><pre class="skill-md">${escapeHtml(res.skillMd || '')}</pre></div>` +
    `<div class="skillhub-row"><button class="btn small primary" type="button" data-skill-action="confirm" ` +
      `data-token="${escapeHtml(res.previewToken || '')}" data-sha="${escapeHtml(res.sha || '')}" ` +
      `data-source="${escapeHtml(source || '')}" data-path="${escapeHtml(path || '')}" data-id="${escapeHtml(id || '')}" data-all="${all ? '1' : ''}">Confirm install</button>` +
      `<button class="btn small ghost" type="button" data-skill-action="cancel-preview">Cancel</button></div>` +
    `</div>`;
  el.scrollIntoView({ block: 'nearest' });
}

async function installGitHubSkill(source, path, id, all) {
  if (!source) { skillHubStatus('Enter a GitHub source first.', 'bad'); return; }
  clearSkillPreview();
  skillHubStatus(`Preparing a review for ${path || id || source}…`, 'busy');
  const res = await api('/api/skills/install/preview', { method: 'POST', body: JSON.stringify({ source, path, id, all: !!all }) });
  if (res.needsSelection) {
    $('skillResults').innerHTML = (res.skills || []).map((s) => skillItemHtml(s, source)).join('');
    skillHubStatus(res.error || 'choose a skill', 'bad');
    return;
  }
  if (!res.ok) { skillHubStatus(res.error || 'preview failed', 'bad'); return; }
  showSkillPreview(res, source, path, id, all);
  const warn = (res.flags || []).length;
  skillHubStatus(`Review ready at commit ${String(res.sha || '').slice(0, 12)} — ${warn} warning flag${warn === 1 ? '' : 's'}. Confirm to install.`, warn ? '' : 'ok');
}

async function confirmGitHubSkill(btn) {
  const token = btn.dataset.token;
  const sha = btn.dataset.sha;
  const source = btn.dataset.source;
  const path = btn.dataset.path;
  const id = btn.dataset.id;
  const all = btn.dataset.all === '1';
  if (!token || !sha) { skillHubStatus('this preview is incomplete — preview again', 'bad'); return; }
  btn.disabled = true;
  skillHubStatus(`Installing ${String(sha).slice(0, 12)}…`, 'busy');
  const res = await api('/api/skills/install/confirm', { method: 'POST', body: JSON.stringify({ source, sha, previewToken: token }) });
  if (!res.ok) { btn.disabled = false; skillHubStatus(res.error || 'install failed', 'bad'); return; }
  state.installedSkills = res.installed || [];
  const names = (res.installed || []).map((s) => s.name || s.id).join(', ');
  skillHubStatus(`✓ Installed ${names} at ${String(sha).slice(0, 12)}`, 'ok');
  $('skillSource').value = '';
  clearSkillPreview();
  if ($('installedSkillsList')) $('installedSkillsList').innerHTML = skillChips(res.skills || []);
  if (path || id) {
    // mark the row installed without re-fetching the whole repo
    const row = Array.from(document.querySelectorAll('#skillResults [data-skill-action="install"]'))
      .find((b) => b.dataset.path === path && b.dataset.id === id);
    if (row) { row.outerHTML = '<span class="skill-installed">installed</span>'; }
  }
  if (all) browseSkillRepo(source).catch(() => {});
}

async function uninstallGitHubSkill(id) {
  if (!confirm(`Remove skill "${id}"?`)) return;
  const res = await api('/api/skills/uninstall', { method: 'POST', body: JSON.stringify({ id }) });
  if (!res.ok) { skillHubStatus(res.error || 'remove failed', 'bad'); return; }
  state.installedSkills = res.installed || [];
  skillHubStatus(`Removed ${id}`, 'ok');
  if ($('installedSkillsList')) $('installedSkillsList').innerHTML = skillChips(res.skills || []);
  document.querySelectorAll('#skillResults [data-skill-action="remove"]').forEach((b) => {
    if (b.dataset.id === id) b.outerHTML = `<button class="btn small primary" type="button" data-skill-action="install" data-source="${escapeHtml($('skillSource').value.trim())}" data-id="${escapeHtml(id)}" data-path="">Install</button>`;
  });
}

function wireSkillHub() {
  const btn = $('skillSearch');
  if (!btn) return;
  btn.addEventListener('click', () => searchGitHubSkills().catch((e) => skillHubStatus(e.message, 'bad')));
  $('skillQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchGitHubSkills().catch((err) => skillHubStatus(err.message, 'bad')); }
  });
  $('skillInstall').addEventListener('click', () => {
    const source = $('skillSource').value.trim();
    const m = /^(.*?)(?:\s+path:(\S+))?$/.exec(source);
    installGitHubSkill(source, m && m[2] ? m[2] : '', '', false).catch((e) => skillHubStatus(e.message, 'bad'));
  });
  $('skillSource').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('skillInstall').click(); }
  });
  $('skillResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-skill-action]');
    if (!b) return;
    const action = b.dataset.skillAction;
    if (action === 'browse') browseSkillRepo(b.dataset.source).catch((err) => skillHubStatus(err.message, 'bad'));
    else if (action === 'install') installGitHubSkill(b.dataset.source, b.dataset.path, b.dataset.id, false).catch((err) => skillHubStatus(err.message, 'bad'));
    else if (action === 'install-all') installGitHubSkill(b.dataset.source, '', '', true).catch((err) => skillHubStatus(err.message, 'bad'));
    else if (action === 'remove') uninstallGitHubSkill(b.dataset.id).catch((err) => skillHubStatus(err.message, 'bad'));
  });
  $('skillPreview').addEventListener('click', (e) => {
    const b = e.target.closest('[data-skill-action]');
    if (!b) return;
    if (b.dataset.skillAction === 'confirm') confirmGitHubSkill(b).catch((err) => skillHubStatus(err.message, 'bad'));
    else if (b.dataset.skillAction === 'cancel-preview') { clearSkillPreview(); skillHubStatus('Install cancelled.', ''); }
  });
}

/* ---------- summaries + export ---------- */

function sessionToMarkdown(s) {
  const lines = [`# ${s.title || 'Session'}`, '', `Agent: ${s.agent || 'create'} · ${s.createdAt || ''}`, ''];
  for (const m of s.messages || []) {
    if (m.role === 'user') lines.push('## you', '', m.content, '');
    else if (m.role === 'assistant') {
      if (m.thinking) lines.push('<details><summary>thinking</summary>', '', m.thinking, '', '</details>', '');
      if (m.content) lines.push('## agent', '', m.content, '');
      for (const tc of m.toolCalls || []) lines.push(`> ⚙ ${tc.function && tc.function.name}(${truncate(String((tc.function && tc.function.arguments) || ''), 200)})`);
    } else if (m.role === 'tool') lines.push(`> ← ${truncate(String(m.content || ''), 300)}`);
  }
  return lines.join('\n');
}

function openSummaries() {
  const body = $('summariesBody');
  if (!state.sessionId) { body.innerHTML = '<p class="hint-line">No session open.</p>'; $('summariesDlg').showModal(); return; }
  const s = { title: $('sessionList .active .t') ? $('sessionList .active .t').textContent : 'Session', agent: $('agent').value, messages: state.messages };
  body.innerHTML = `<p class="hint-line">${state.messages.length} message(s) in this session. Export gives you the full transcript as markdown.</p>` +
    '<pre style="max-height:40vh;overflow:auto;font-size:11px;white-space:pre-wrap">' + escapeHtml(truncate(sessionToMarkdown(s), 4000)) + '</pre>';
  $('summariesDlg').showModal();
}

function exportSession() {
  if (!state.sessionId) return;
  const md = sessionToMarkdown({ title: 'session-' + state.sessionId.slice(0, 8), agent: $('agent').value, messages: state.messages });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `session-${state.sessionId.slice(0, 8)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- message menu ---------- */

let menuFor = null;
function closeMenu() { $('ctxMenu').hidden = true; menuFor = null; }

function flash(text) {
  setStatus(text, 'ok');
  setTimeout(() => { if ($('connStatus').textContent === text) setStatus(state.streaming ? 'working…' : 'ready', state.streaming ? 'busy' : 'ok'); }, 1400);
}

function openMsgMenu(el, x, y) {
  if (menuFor === el && !$('ctxMenu').hidden) return;
  const idx = el.dataset.idx === undefined ? -1 : Number(el.dataset.idx);
  const m = idx >= 0 ? state.messages[idx] : null;
  const isUser = el.classList.contains('user');
  const raw = el.dataset.raw || '';
  const busy = state.streaming || !m;
  const items = [
    { label: 'Copy', hint: isUser ? '' : 'markdown', run: () => window.copyToClipboard(raw).then(() => flash('copied')) },
    { label: 'Copy text', hint: 'plain', run: () => window.copyToClipboard(isUser ? raw : window.markdownToText(raw)).then(() => flash('copied text')) },
    { label: 'Edit', disabled: busy || idx < 0, run: () => openEdit(idx, m, isUser) },
    { label: isUser ? 'Resend' : 'Regenerate', disabled: busy || !isUser, run: () => resendFrom(idx, m) },
  ];
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.disabled = !!it.disabled;
    b.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.hint ? `<small>${escapeHtml(it.hint)}</small>` : ''}`;
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  menuFor = el;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
}

function openEdit(idx, m, isUser) {
  $('editTitle').textContent = isUser ? 'Edit your message' : 'Edit agent message';
  $('editText').value = m.content || '';
  $('editNote').textContent = 'everything after this message is dropped from the conversation';
  $('editDlg').dataset.idx = idx;
  $('editDlg').showModal();
}

async function saveEdit() {
  const idx = Number($('editDlg').dataset.idx);
  if (!state.sessionId || !Number.isInteger(idx) || idx < 0) { $('editDlg').close(); return; }
  await api(`/api/sessions/${state.sessionId}/messages/edit`, { method: 'POST', body: JSON.stringify({ index: idx, content: $('editText').value }) });
  $('editDlg').close();
  await openSession(state.sessionId);
  setStatus('message edited', 'ok');
}

async function resendFrom(idx, m) {
  if (!state.sessionId || state.streaming) return;
  await api(`/api/sessions/${state.sessionId}/messages/edit`, { method: 'POST', body: JSON.stringify({ index: idx, content: m.content }) });
  await openSession(state.sessionId);
  startRun();   // continue without a new user message → the agent re-answers
}

/* ---------- boot ---------- */

/* ---------- responsive / mobile UI state ----------
   Pure presentation: these helpers only toggle CSS classes/attributes and body
   state. They never touch sessions, models, the agent loop or any API call. */

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

/* Keep --app-header-h in sync with the real top bar height so the mobile editor
   modal always starts strictly below the app banner (never under it). */
function syncHeaderHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const h = Math.round(bar.getBoundingClientRect().height);
  if (h > 0) document.body.style.setProperty('--app-header-h', h + 'px');
}

function openDrawer(which) {
  document.body.dataset.drawer = which;
  $('panelBackdrop').hidden = false;
  $('hamburgerBtn').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  delete document.body.dataset.drawer;
  $('panelBackdrop').hidden = true;
  $('hamburgerBtn').setAttribute('aria-expanded', 'false');
}

function closeAllDrawers() {
  closeDrawer();
  $('editorPane').classList.remove('open');
  document.body.classList.remove('settings-open');
  $('settingsBtn').setAttribute('aria-expanded', 'false');
}

function toggleSettings() {
  const open = document.body.classList.toggle('settings-open');
  $('settingsBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openEditorModal() {
  if (!isMobile()) return;
  $('editorPane').classList.add('open');
}

function closeEditorModal() {
  $('editorPane').classList.remove('open');
}

/* Attach the mobile-only controls right away (before any network calls) so the
   hamburger drawer, settings sheet and editor modal always respond instantly. */
function wireMobileUi() {
  $('hamburgerBtn').addEventListener('click', () => {
    const open = document.body.dataset.drawer === 'sessions';
    if (open) closeDrawer();
    else { closeAllDrawers(); openDrawer('sessions'); }
  });
  $('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
  $('panelBackdrop').addEventListener('click', closeAllDrawers);
  $('drawerClose').addEventListener('click', closeDrawer);
  document.querySelectorAll('[data-close-pane]').forEach((b) => {
    b.addEventListener('click', () => closeDrawer());
  });
  $('closeEditor').addEventListener('click', closeEditorModal);
  // a tap outside an open settings sheet closes it (but keep taps inside the sheet)
  $('connBar').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('settings-open')) return;
    if ($('settingsBtn').contains(e.target) || $('connBar').contains(e.target)) return;
    closeAllDrawers();
  });
  // keep --app-header-h accurate and reset mobile state when crossing the breakpoint
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    syncHeaderHeight();
    if (isMobile() === wasMobile) return;
    wasMobile = isMobile();
    closeAllDrawers();
  });
  syncHeaderHeight();
  // the top bar can change height (font load, workdir wrapping) — track it live
  const bar = document.querySelector('.topbar');
  if (bar && typeof ResizeObserver === 'function') {
    new ResizeObserver(syncHeaderHeight).observe(bar);
  }
  window.addEventListener('load', syncHeaderHeight);
}

async function init() {
  // Wire the mobile UI first so the hamburger / settings / editor controls work
  // instantly, even while config and models are still loading (or fail to load).
  wireMobileUi();
  wireSkillHub();

  await loadConfig();
  showWorkDir();
  const [agentsR] = await Promise.all([
    api('/api/agents').catch(() => ({ agents: [{ id: 'create', label: 'Create' }, { id: 'analyze', label: 'Analyze' }] })),
    loadSessions().catch(() => {}),
    loadTree().catch(() => {}),
    loadModels().catch(() => {}),
  ]);
  fillAgents(agentsR.agents || [], state.config.agent);
  addHint();

  // top bar
  $('saveConfig').addEventListener('click', () => saveConfigNow().catch((e) => setStatus(e.message, 'err')));
  $('refreshModels').addEventListener('click', () => loadModels());
  $('providersBtn').addEventListener('click', openProviders);
  $('statusBtn').addEventListener('click', openStatus);
  $('statusClose').addEventListener('click', () => $('statusDlg').close());
  $('quitBtn').addEventListener('click', async () => {
    if (!confirm('Stop the studio server?')) return;
    try { await fetch('/api/quit', { method: 'POST' }); } catch { /* server is gone */ }
    setStatus('server stopped', 'err');
  });
  $('endpoint').addEventListener('change', () => { setStatus('endpoint changed — reloading models…', 'busy'); loadModels(); });

  // model dropdown
  $('modelBtn').addEventListener('click', () => mselOpen());
  document.addEventListener('click', (e) => { if (!$('modelSel').contains(e.target)) mselOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { mselOpen(false); closeMenu(); closeAllDrawers(); } });

  // sessions
  $('newSession').addEventListener('click', newSession);
  $('archivedBtn').addEventListener('click', () => { state.archivedView = !state.archivedView; loadSessions(); });
  $('summariesBtn').addEventListener('click', openSummaries);
  $('summariesClose').addEventListener('click', () => $('summariesDlg').close());
  $('exportFromSummaries').addEventListener('click', exportSession);

  // files
  $('refreshTree').addEventListener('click', () => loadTree().catch((e) => setStatus(e.message, 'err')));
  $('newFile').addEventListener('click', () => createFile().catch((e) => setStatus(e.message, 'err')));
  $('saveFile').addEventListener('click', () => saveFile().catch((e) => setStatus(e.message, 'err')));
  $('editor').addEventListener('input', () => setDirty(true));
  $('workDir').addEventListener('click', () => { $('workDir').textContent = state.workDir; });

  // chat
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) { stopRun(); return; }
    const text = $('prompt').value.trim();
    if (!text) return;
    $('prompt').value = '';
    document.querySelectorAll('#messages .notice').forEach((n) => { if (n.textContent.startsWith('Working in')) n.remove(); });
    addMessage('user', text);
    startRun(text).catch((err) => { addErrorBubble(err.message); setStatus('error', 'err'); });
  });
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); }
  });
  $('agent').addEventListener('change', () => { if (state.sessionId) api(`/api/sessions/${state.sessionId}/agent`, { method: 'POST', body: JSON.stringify({ agent: $('agent').value }) }).catch(() => {}); });

  // edit dialog
  $('editCancel').addEventListener('click', () => $('editDlg').close());
  $('editSave').addEventListener('click', () => saveEdit().catch((e) => setStatus(e.message, 'err')));

  // providers dialog extras
  $('addProvider').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = providerRowHtml('', { type: 'openai', endpoint: '' }, false);
    $('providerRows').appendChild(div.firstElementChild);
    bindProviderRows();
  });
  $('providersCancel').addEventListener('click', () => $('providersDlg').close());
  $('providersSave').addEventListener('click', () => saveProviders().catch((e) => { alert(e.message); setStatus(e.message, 'err'); }));

  // YouTube credentials
  $('saveYtCreds').addEventListener('click', saveYtCreds);
  $('connectAgent').addEventListener('click', connectAgent);
  if ($('connectIgAgent')) $('connectIgAgent').addEventListener('click', connectIgAgent);
  if ($('connectFbAgent')) $('connectFbAgent').addEventListener('click', connectFbAgent);
  if ($('connectGAgent')) $('connectGAgent').addEventListener('click', connectGAgent);
  $('saveIgCreds').addEventListener('click', async () => {
    const clientId = $('igClientId').value.trim();
    const clientSecret = $('igClientSecret').value.trim();
    if (!clientId || !clientSecret) { setIgStatus('both Client ID and Client Secret are required', 'bad'); return; }
    try {
      state.config = await api('/api/instagram/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      $('igClientSecret').value = state.config.instagram ? state.config.instagram.clientSecretMasked : '';
      setIgStatus('✓ keys saved — press Connect Agent to grant access', 'ok');
      const btn = $('connectIgAgent'); if (btn) btn.disabled = false;
    } catch (e) { setIgStatus('save failed: ' + e.message, 'bad'); }
  });
  $('saveFbCreds').addEventListener('click', async () => {
    const clientId = $('fbClientId').value.trim();
    const clientSecret = $('fbClientSecret').value.trim();
    if (!clientId || !clientSecret) { setFbStatus('both Client ID and Client Secret are required', 'bad'); return; }
    try {
      state.config = await api('/api/facebook/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      $('fbClientSecret').value = state.config.facebook ? state.config.facebook.clientSecretMasked : '';
      setFbStatus('✓ keys saved — press Connect Agent to grant access', 'ok');
      const btn = $('connectFbAgent'); if (btn) btn.disabled = false;
    } catch (e) { setFbStatus('save failed: ' + e.message, 'bad'); }
  });
  $('saveGCreds').addEventListener('click', async () => {
    const clientId = $('gClientId').value.trim();
    const clientSecret = $('gClientSecret').value.trim();
    if (!clientId || !clientSecret) { setGStatus('both Client ID and Client Secret are required', 'bad'); return; }
    try {
      state.config = await api('/api/google/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      $('gClientSecret').value = state.config.google ? state.config.google.clientSecretMasked : '';
      setGStatus('✓ keys saved — press Connect Agent to grant access', 'ok');
      const btn = $('connectGAgent'); if (btn) btn.disabled = false;
    } catch (e) { setGStatus('save failed: ' + e.message, 'bad'); }
  });

  // YouTube Studio panel
  $('openYtStudio').addEventListener('click', openYtStudio);
  $('closeYtStudio').addEventListener('click', closeYtStudio);
  $('collapseYtStudio').addEventListener('click', toggleCollapseYtStudio);
  $('launchBrowser').addEventListener('click', launchAutomationBrowser);

  // Auto-Forge
  $('autoForgeBtn').addEventListener('click', promptAutoForge);
  $('autoforgeClose').addEventListener('click', () => { $('autoforgePanel').hidden = true; });

  // context menu dismiss
  document.addEventListener('click', (e) => { if (!$('ctxMenu').contains(e.target)) closeMenu(); });
  $('messages').addEventListener('contextmenu', (e) => {
    const msg = e.target.closest('.msg.user, .msg.assistant');
    if (msg && msg.dataset.idx !== undefined) { e.preventDefault(); openMsgMenu(msg, e.clientX, e.clientY); }
  });
}

init().catch((e) => {
  console.error(e);
  setStatus('boot failed: ' + e.message, 'err');
  const d = document.createElement('div');
  d.className = 'notice err';
  d.textContent = '✖ ' + e.message;
  document.body.prepend(d);
});
