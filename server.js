#!/usr/bin/env node
'use strict';

// agent-forge-studio server — zero-dependency HTTP + SSE around the agent loop.
// Serves the browser UI, the session/file/agent APIs, and streams agent runs as SSE events.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

const log = require('./lib/log');
const cfgLib = require('./lib/config');
const { ensureSecretDir } = require('./lib/secret-store');
const sessions = require('./lib/sessions');
const agentsLib = require('./lib/agents');
const toolsLib = require('./lib/tools');
const skillsLib = require('./lib/skills');
const commandsLib = require('./lib/commands');
const agentLib = require('./lib/agent');
const llm = require('./lib/llm');
const ws = require('./lib/workspace');
const { statusFor, explain } = require('./lib/errors');
const { isSea, getAsset } = require('./lib/runtime');
const browser = require('./lib/browser');

const PORT = Number(process.env.PORT) || 4312;
const HOST = process.env.HOST || '127.0.0.1';

// pending interactive answers (permission/question) keyed by id
const pending = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Parse the Cookie header into a plain object (values are not decoded beyond URI decoding). */
function parseCookies(req) {
  const out = {};
  const header = (req.headers && req.headers.cookie) || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}

function escapeHtmlHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function publicConfig() {
  const c = cfgLib.loadConfig();
  const out = { ...c, apiKey: maskKey(c.apiKey), providers: {}, workDir: cfgLib.getWorkDir() };
  for (const [id, p] of Object.entries(c.providers || {})) {
    out.providers[id] = { ...p, apiKey: maskKey(p.apiKey) };
  }
  try {
    const yt = require('./lib/youtube/oauth');
    const c2 = cfgLib.loadConfig();
    out.youtube = {
      clientId: (c2.youtube && c2.youtube.clientId) || '',
      clientSecretMasked: maskKey(c2.youtube && c2.youtube.clientSecret),
      redirectUri: (c2.youtube && c2.youtube.redirectUri) || '',
      hasCredentials: yt.hasCredentials(c2),
      hasToken: !!yt.loadToken(),
      scopes: yt.SCOPES,
    };
  } catch (e) { /* ignore */ }
  try {
    const ig = require('./lib/instagram');
    const c2 = cfgLib.loadConfig();
    out.instagram = {
      clientId: (c2.instagram && c2.instagram.clientId) || '',
      clientSecretMasked: maskKey(c2.instagram && c2.instagram.clientSecret),
      redirectUri: (c2.instagram && c2.instagram.redirectUri) || '',
      hasCredentials: ig.hasCredentials(c2),
      hasToken: !!ig.loadToken(),
      scopes: ig.SCOPES,
      username: (ig.loadToken() && ig.loadToken().username) || null,
      igUserId: (ig.loadToken() && ig.loadToken().igUserId) || null,
    };
  } catch (e) { /* ignore */ }
  try {
    const fb = require('./lib/facebook');
    const c2 = cfgLib.loadConfig();
    out.facebook = {
      clientId: (c2.facebook && c2.facebook.clientId) || '',
      clientSecretMasked: maskKey(c2.facebook && c2.facebook.clientSecret),
      redirectUri: (c2.facebook && c2.facebook.redirectUri) || '',
      hasCredentials: fb.hasCredentials(c2),
      hasToken: !!fb.loadToken(),
      scopes: fb.SCOPES,
      accountName: (() => { const t = fb.loadToken(); const ids = t && t.pages ? Object.keys(t.pages) : []; return (ids[0] && t.page_names && t.page_names[ids[0]]) || null; })(),
      pages: (() => { const t = fb.loadToken(); return t && t.pages ? Object.keys(t.pages).map((id) => ({ id, name: (t.page_names && t.page_names[id]) || null })) : []; })(),
    };
  } catch (e) { /* ignore */ }
  try {
    const g = require('./lib/google');
    const c2 = cfgLib.loadConfig();
    out.google = {
      clientId: (c2.google && c2.google.clientId) || '',
      clientSecretMasked: maskKey(c2.google && c2.google.clientSecret),
      redirectUri: (c2.google && c2.google.redirectUri) || '',
      hasCredentials: g.hasCredentials(c2),
      hasToken: !!g.loadToken(),
      scopes: g.SCOPES,
      email: (g.loadToken() && g.loadToken().email) || null,
    };
  } catch (e) { /* ignore */ }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveAsset(res, key, mime) {
  const embedded = getAsset(key);
  if (embedded) {
    res.writeHead(200, { 'content-type': mime, 'content-length': embedded.length });
    res.end(embedded);
    return true;
  }
  const file = path.join(cfgLib.APP_ROOT || '', 'public', key);
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': mime, 'content-length': data.length });
    res.end(data);
    return true;
  } catch { return false; }
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client gone */ }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ---- config ----
  if (p === '/api/config' && method === 'GET') return json(res, 200, publicConfig());
  if (p === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    const saved = cfgLib.saveConfig(body);
    return json(res, 200, publicConfig());
  }
  if (p === '/api/youtube/credentials' && method === 'POST') {
    const body = await readBody(req);
    const patch = {
      youtube: {
        clientId: String(body.clientId || '').trim(),
        clientSecret: String(body.clientSecret || '').trim(),
        redirectUri: String(body.redirectUri || '').trim(),
      }
    };
    cfgLib.saveConfig(patch);
    return json(res, 200, publicConfig());
  }
  if (p === '/api/instagram/credentials' && method === 'POST') {
    const body = await readBody(req);
    const patch = {
      instagram: {
        clientId: String(body.clientId || '').trim(),
        clientSecret: String(body.clientSecret || '').trim(),
        redirectUri: String(body.redirectUri || '').trim(),
      }
    };
    cfgLib.saveConfig(patch);
    return json(res, 200, publicConfig());
  }
  if (p === '/api/facebook/credentials' && method === 'POST') {
    const body = await readBody(req);
    const patch = {
      facebook: {
        clientId: String(body.clientId || '').trim(),
        clientSecret: String(body.clientSecret || '').trim(),
        redirectUri: String(body.redirectUri || '').trim(),
      }
    };
    cfgLib.saveConfig(patch);
    return json(res, 200, publicConfig());
  }
  if (p === '/api/google/credentials' && method === 'POST') {
    const body = await readBody(req);
    const patch = {
      google: {
        clientId: String(body.clientId || '').trim(),
        clientSecret: String(body.clientSecret || '').trim(),
        redirectUri: String(body.redirectUri || '').trim(),
      }
    };
    cfgLib.saveConfig(patch);
    return json(res, 200, publicConfig());
  }
  if (p === '/api/youtube/connect' && method === 'POST') {
    const oauth = require('./lib/youtube/oauth');
    const state = oauth.createState();
    // bind the flow to this browser: the signed state travels in an HttpOnly cookie and must
    // match the `state` Google echoes back on the callback (CSRF protection).
    res.setHeader('set-cookie', `yt_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/youtube/callback; Max-Age=600`);
    const url = oauth.buildAuthUrl({ redirectUri: oauth.redirectUri(req), state });
    return json(res, 200, { ok: true, url });
  }
  if (p === '/api/youtube/status' && method === 'GET') {
    const oauth = require('./lib/youtube/oauth');
    const c2 = cfgLib.loadConfig();
    const t = oauth.loadToken();
    return json(res, 200, {
      hasCredentials: oauth.hasCredentials(c2),
      hasToken: !!t,
      obtainedAt: (t && (t.refreshed_at || t.obtained_at)) || null,
      scopes: (t && t.scope) ? t.scope.split(' ') : oauth.SCOPES,
    });
  }
  if (p === '/auth/youtube/callback' && method === 'GET') {
    const oauth = require('./lib/youtube/oauth');
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req).yt_oauth_state || '';
    // clear the one-time cookie regardless of outcome
    res.setHeader('set-cookie', 'yt_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/youtube/callback; Max-Age=0');
    const done = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent Forge Studio</title>
<style>body{background:#0f0f0f;color:#f1f1f1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:440px}
.ok{color:#2ba640;font-size:38px}.bad{color:#ff4d4f;font-size:38px}code{color:#ff6680}</style></head>
<body><div class="card">${status === 200 ? '<div class="ok">✓</div><h2>YouTube agent connected</h2>' : '<div class="bad">✗</div><h2>Connection failed</h2>'}
<p style="color:#aaa">${status === 200 ? 'Full studio scopes granted. You can close this tab and return to Agent Forge Studio.' : escapeHtmlHtml(err || 'no code returned')}</p></div></body></html>`);
    };
    if (err) return done(400, err);
    // CSRF: the state Google echoes must match the signed cookie this server handed out.
    if (!state || !cookieState || state !== cookieState || !oauth.verifyState(state)) {
      log.warn('youtube', 'OAuth callback rejected: state missing or mismatched (possible CSRF)');
      return done(400, 'invalid or expired OAuth state — start the connection again from the app');
    }
    if (!code) return done(400, 'no authorization code in the callback');
    try {
      await oauth.exchangeCode(code, { redirectUri: oauth.redirectUri(req) });
      return done(200);
    } catch (e) {
      log.error('youtube', 'OAuth callback failed', e);
      return done(400, e.message);
    }
  }
  if (p === '/auth/instagram/connect' && method === 'GET') {
    const ig = require('./lib/instagram');
    try {
      const state = ig.createState();
      res.setHeader('set-cookie', `ig_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/instagram/callback; Max-Age=600`);
      const port = (server.address() && server.address().port) || PORT;
      return redirect(res, ig.buildAuthUrl({ redirectUri: ig.redirectUri({ port }), state }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (p === '/api/instagram/connect' && method === 'POST') {
    const ig = require('./lib/instagram');
    const state = ig.createState();
    res.setHeader('set-cookie', `ig_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/instagram/callback; Max-Age=600`);
    const port = (server.address() && server.address().port) || PORT;
    const url = ig.buildAuthUrl({ redirectUri: ig.redirectUri({ port }), state });
    return json(res, 200, { ok: true, url });
  }
  if (p === '/api/instagram/status' && method === 'GET') {
    const ig = require('./lib/instagram');
    try {
      return json(res, 200, ig.status());
    } catch (e) {
      return json(res, 200, { hasCredentials: false, hasToken: false, error: e.message });
    }
  }
  if (p === '/auth/instagram/callback' && method === 'GET') {
    const ig = require('./lib/instagram');
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req).ig_oauth_state || '';
    res.setHeader('set-cookie', 'ig_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/instagram/callback; Max-Age=0');
    const done = (status, msg) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent Forge Studio</title>
<style>body{background:#0f0f0f;color:#f1f1f1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:440px}
.ok{color:#2ba640;font-size:38px}.bad{color:#ff4d4f;font-size:38px}code{color:#ff6680}</style></head>
<body><div class="card">${status === 200 ? '<div class="ok">✓</div><h2>Instagram agent connected</h2>' : '<div class="bad">✗</div><h2>Connection failed</h2>'}
<p style="color:#aaa">${status === 200 ? 'Instagram Business/Creator connected. You can close this tab and return to Agent Forge Studio.' : escapeHtmlHtml(msg || err || 'no code returned')}</p></div></body></html>`);
    };
    if (!state || !cookieState || state !== cookieState || !ig.verifyState(state)) {
      log.warn('instagram', 'OAuth callback rejected: state missing or mismatched');
      return done(400, 'invalid or expired OAuth state — start the connection again from the app');
    }
    if (err) return done(400, err);
    if (!code) return done(400, 'no authorization code in the callback');
    try {
      const port = (server.address() && server.address().port) || PORT;
      await ig.completeAuthorization(code, { redirectUri: ig.redirectUri({ port }) });
      return done(200);
    } catch (e) {
      log.error('instagram', 'OAuth callback failed', e);
      return done(400, e.message);
    }
  }

  if (p === '/auth/facebook/connect' && method === 'GET') {
    const fb = require('./lib/facebook');
    try {
      const state = fb.createState();
      res.setHeader('set-cookie', `fb_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/facebook/callback; Max-Age=600`);
      const port = (server.address() && server.address().port) || PORT;
      return redirect(res, fb.buildAuthUrl({ redirectUri: fb.redirectUri({ port }), state }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (p === '/api/facebook/connect' && method === 'POST') {
    const fb = require('./lib/facebook');
    const state = fb.createState();
    res.setHeader('set-cookie', `fb_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/facebook/callback; Max-Age=600`);
    const port = (server.address() && server.address().port) || PORT;
    const urlFb = fb.buildAuthUrl({ redirectUri: fb.redirectUri({ port }), state });
    return json(res, 200, { ok: true, url: urlFb });
  }
  if (p === '/api/facebook/status' && method === 'GET') {
    const fb = require('./lib/facebook');
    try {
      return json(res, 200, fb.status());
    } catch (e) {
      return json(res, 200, { hasCredentials: false, hasToken: false, error: e.message });
    }
  }
  if (p === '/auth/facebook/callback' && method === 'GET') {
    const fb = require('./lib/facebook');
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req).fb_oauth_state || '';
    res.setHeader('set-cookie', 'fb_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/facebook/callback; Max-Age=0');
    const done = (status, msg) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent Forge Studio</title>
<style>body{background:#0f0f0f;color:#f1f1f1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:440px}
.ok{color:#2ba640;font-size:38px}.bad{color:#ff4d4f;font-size:38px}code{color:#ff6680}</style></head>
<body><div class="card">${status === 200 ? '<div class="ok">✓</div><h2>Facebook agent connected</h2>' : '<div class="bad">✗</div><h2>Connection failed</h2>'}
<p style="color:#aaa">${status === 200 ? 'Pages connected. You can close this tab and return to Agent Forge Studio.' : escapeHtmlHtml(msg || err || 'no code returned')}</p></div></body></html>`);
    };
    if (!state || !cookieState || state !== cookieState || !fb.verifyState(state)) {
      log.warn('facebook', 'OAuth callback rejected: state missing or mismatched');
      return done(400, 'invalid or expired OAuth state — start the connection again from the app');
    }
    if (err) return done(400, err);
    if (!code) return done(400, 'no authorization code in the callback');
    try {
      const port = (server.address() && server.address().port) || PORT;
      await fb.completeAuthorization(code, { redirectUri: fb.redirectUri({ port }) });
      return done(200);
    } catch (e) {
      log.error('facebook', 'OAuth callback failed', e);
      return done(400, e.message);
    }
  }

  if (p === '/auth/google/connect' && method === 'GET') {
    const g = require('./lib/google');
    try {
      const state = g.createState();
      res.setHeader('set-cookie', `g_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=600`);
      const port = (server.address() && server.address().port) || PORT;
      return redirect(res, g.buildAuthUrl({ redirectUri: g.redirectUri({ port }), state }));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (p === '/api/google/connect' && method === 'POST') {
    const g = require('./lib/google');
    const state = g.createState();
    res.setHeader('set-cookie', `g_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=600`);
    const port = (server.address() && server.address().port) || PORT;
    const urlG = g.buildAuthUrl({ redirectUri: g.redirectUri({ port }), state });
    return json(res, 200, { ok: true, url: urlG });
  }
  if (p === '/api/google/status' && method === 'GET') {
    const g = require('./lib/google');
    try {
      return json(res, 200, g.status());
    } catch (e) {
      return json(res, 200, { hasCredentials: false, hasToken: false, error: e.message });
    }
  }
  if (p === '/auth/google/callback' && method === 'GET') {
    const g = require('./lib/google');
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req).g_oauth_state || '';
    res.setHeader('set-cookie', 'g_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=0');
    const done = (status, msg) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent Forge Studio</title>
<style>body{background:#0f0f0f;color:#f1f1f1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:440px}
.ok{color:#2ba640;font-size:38px}.bad{color:#ff4d4f;font-size:38px}code{color:#ff6680}</style></head>
<body><div class="card">${status === 200 ? '<div class="ok">✓</div><h2>Google agent connected</h2>' : '<div class="bad">✗</div><h2>Connection failed</h2>'}
<p style="color:#aaa">${status === 200 ? 'Google account connected. You can close this tab and return to Agent Forge Studio.' : escapeHtmlHtml(msg || err || 'no code returned')}</p></div></body></html>`);
    };
    if (!state || !cookieState || state !== cookieState || !g.verifyState(state)) {
      log.warn('google', 'OAuth callback rejected: state missing or mismatched');
      return done(400, 'invalid or expired OAuth state — start the connection again from the app');
    }
    if (err) return done(400, err);
    if (!code) return done(400, 'no authorization code in the callback');
    try {
      const port = (server.address() && server.address().port) || PORT;
      await g.completeAuthorization(code, { redirectUri: g.redirectUri({ port }) });
      return done(200);
    } catch (e) {
      log.error('google', 'OAuth callback failed', e);
      return done(400, e.message);
    }
  }


  // ---- models ----
  if (p === '/api/models' && method === 'GET') {
    const c = cfgLib.loadConfig();
    const providerId = url.searchParams.get('provider') || c.defaultProvider || 'default';
    const provider = llm.resolveProvider(c, providerId);
    let models = [];
    let error = null;
    try {
      const mod = { ollama: () => require('./lib/ollama'), openai: () => require('./lib/openai'), anthropic: () => require('./lib/anthropic') }[provider.type]();
      models = await mod.listModels(provider);
    } catch (e) {
      error = e.message;
      models = [{ id: '⚠ ' + e.message.slice(0, 80), name: '⚠ ' + e.message.slice(0, 80), error: e.message }];
    }
    return json(res, 200, { models, provider: { id: provider.id, type: provider.type, endpoint: provider.endpoint }, error });
  }

  // ---- sessions ----
  if (p === '/api/sessions' && method === 'GET') {
    const archived = url.searchParams.get('archived') === '1';
    return json(res, 200, { sessions: sessions.listSessions({ archived }) });
  }
  if (p === '/api/sessions' && method === 'POST') {
    const body = await readBody(req);
    const c = cfgLib.loadConfig();
    const s = sessions.createSession({ title: body.title || 'New session', agent: body.agent || c.agent || 'create' });
    return json(res, 200, s);
  }
  let m;
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)$/.exec(p))) {
    if (method === 'GET') return json(res, 200, sessions.loadSession(m[1]));
    if (method === 'DELETE') return json(res, 200, { ok: sessions.deleteSession(m[1]) });
  }
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)\/archive$/.exec(p)) && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, sessions.archiveSession(m[1], body.archived !== false));
  }
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)\/title$/.exec(p)) && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, sessions.setTitle(m[1], body.title));
  }
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)\/agent$/.exec(p)) && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, sessions.setAgent(m[1], body.agent));
  }
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)\/messages\/edit$/.exec(p)) && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, sessions.editMessage(m[1], body.index, body.content));
  }

  // ---- run (SSE) ----
  if ((m = /^\/api\/sessions\/([0-9a-f-]+)\/run$/.exec(p)) && method === 'POST') {
    const body = await readBody(req);
    const session = sessions.loadSession(m[1]);
    sseStart(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    let errored = false;
    const emit = (event, data) => { if (event === 'error') errored = true; sseSend(res, event, data); };
    try {
      if (body.message != null && String(body.message).trim()) {
        const text = String(body.message);
        const expanded = commandsLib.expand(text);
        sessions.append(session, { role: 'user', content: expanded ? expanded.text : text });
        if (expanded) sseSend(res, 'agent', { command: expanded.name });
      }
      const c = cfgLib.loadConfig();
      const gate = require('./lib/permission').makeGate(
        Object.assign({}, c.permission, (agentsLib.getAgent(session.agent || c.agent) || {}).permission),
        async (info) => new Promise((resolve) => {
          const id = 'perm_' + crypto.randomUUID().slice(0, 8);
          pending.set(id, resolve);
          sseSend(res, 'permission_request', { id, ...info });
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); resolve(false); }
          }, 300000);
        }),
      );
      await agentLib.runLoop({
        session,
        cfg: c,
        emit,
        signal: controller.signal,
        gate,
        onQuestion: async (question, options) => new Promise((resolve) => {
          const id = 'q_' + crypto.randomUUID().slice(0, 8);
          pending.set(id, resolve);
          sseSend(res, 'question', { id, question, options });
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); resolve(''); }
          }, 600000);
        }),
      });
    } catch (e) {
      log.error('server', 'run failed', e);
      if (!errored) sseSend(res, 'error', { message: explain(e) });
      sseSend(res, 'done', { text: '', iterations: 0 });
    }
    res.end();
    return;
  }

  // ---- auto-forge (one-click end-to-end workflow, SSE) ----
  if (p === '/api/workflow/autoforge' && method === 'POST') {
    const body = await readBody(req);
    const idea = String(body.idea || '').trim();
    sseStart(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const emit = (event, data) => sseSend(res, event, data);
    try {
      if (!idea) { sseSend(res, 'error', { message: 'an idea is required to start Auto-Forge' }); sseSend(res, 'done', { text: '' }); res.end(); return; }
      const autoforge = require('./lib/autoforge');
      const c = { ...cfgLib.loadConfig(), signal: controller.signal };
      // the human answers the upload gate through the shared question channel
      const onQuestion = async (question, options) => new Promise((resolve) => {
        const id = 'q_' + crypto.randomUUID().slice(0, 8);
        pending.set(id, resolve);
        sseSend(res, 'question', { id, question, options });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(''); } }, 600000);
      });
      const result = await autoforge.runAutoForge({ idea, cfg: c, emit, signal: controller.signal, onQuestion });
      if (!result.ok) {
        sseSend(res, 'error', { message: `Error in Auto-Forge step "${result.failedStep}"`, failedStep: result.failedStep });
      }
    } catch (e) {
      log.error('server', 'autoforge failed', e);
      sseSend(res, 'error', { message: explain(e) });
    }
    sseSend(res, 'done', { text: '' });
    res.end();
    return;
  }

  // ---- interactive answers ----
  if (p === '/api/answer' && method === 'POST') {
    const body = await readBody(req);
    const resolve = pending.get(body.id);
    if (resolve) { pending.delete(body.id); resolve(body.answer); }
    return json(res, 200, { ok: !!resolve });
  }

  // ---- agents / skills / commands ----
  if (p === '/api/agents' && method === 'GET') {
    const all = agentsLib.allAgents();
    return json(res, 200, { agents: Object.values(all).map((a) => ({ id: a.id, label: a.label || a.id, primary: !!a.primary, subagent: !!a.subagent, voice: !!a.voice })) });
  }
  if (p === '/api/skills' && method === 'GET') return json(res, 200, { skills: skillsLib.listSkills() });
  if (p === '/api/commands' && method === 'GET') return json(res, 200, { commands: Object.values(commandsLib.listCommands()) });

  // ---- GitHub skill hub ----
  if (p === '/api/skills/discover' && method === 'GET') {
    const hub = require('./lib/skillhub');
    try {
      const data = await hub.discoverSkills(url.searchParams.get('q') || '', { limit: Number(url.searchParams.get('limit')) || 10 });
      return json(res, 200, { ok: true, ...data, installed: hub.installedSkills() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, repos: [] });
    }
  }
  if (p === '/api/skills/repo' && method === 'GET') {
    const hub = require('./lib/skillhub');
    const source = url.searchParams.get('source') || '';
    try {
      return json(res, 200, { ok: true, ...(await hub.listGitHubSkills(source)) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, skills: [] });
    }
  }
  if (p === '/api/skills/install/preview' && method === 'POST') {
    const body = await readBody(req);
    const hub = require('./lib/skillhub');
    try {
      const out = await hub.previewInstall(String(body.source || ''), {
        id: body.id ? String(body.id) : undefined,
        path: body.path ? String(body.path) : undefined,
        all: !!body.all,
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/skills/install/confirm' && method === 'POST') {
    const body = await readBody(req);
    const hub = require('./lib/skillhub');
    try {
      const out = await hub.confirmInstall(String(body.source || ''), {
        sha: String(body.sha || body.commit || ''),
        previewToken: String(body.previewToken || body.token || ''),
        force: !!body.force,
      });
      return json(res, 200, { ...out, skills: skillsLib.listSkills(), installed: hub.installedSkills() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, skills: skillsLib.listSkills() });
    }
  }
  if (p === '/api/skills/install' && method === 'POST') {
    const body = await readBody(req);
    const hub = require('./lib/skillhub');
    try {
      if (body.sha || body.commit || body.previewToken) {
        const out = await hub.confirmInstall(String(body.source || ''), {
          sha: String(body.sha || body.commit || ''),
          previewToken: String(body.previewToken || body.token || ''),
          force: !!body.force,
        });
        return json(res, 200, { ...out, skills: skillsLib.listSkills(), installed: hub.installedSkills() });
      }
      const out = await hub.previewInstall(String(body.source || ''), {
        id: body.id ? String(body.id) : undefined,
        path: body.path ? String(body.path) : undefined,
        all: !!body.all,
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, skills: skillsLib.listSkills() });
    }
  }
  if (p === '/api/skills/uninstall' && method === 'POST') {
    const body = await readBody(req);
    const hub = require('./lib/skillhub');
    try {
      const out = hub.uninstallSkill(String(body.id || ''));
      return json(res, 200, { ...out, skills: skillsLib.listSkills(), installed: hub.installedSkills() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/skills/installed' && method === 'GET') {
    const hub = require('./lib/skillhub');
    return json(res, 200, { installed: hub.installedSkills(), skills: skillsLib.listSkills() });
  }

  // ---- open-web research / download (also available through the CLI) ----
  if (p === '/api/research' && method === 'GET') {
    const webLib = require('./lib/web');
    const q = url.searchParams.get('q') || '';
    try {
      return json(res, 200, { ok: true, ...(await webLib.research(q, { count: Number(url.searchParams.get('count')) || 8, fetchCount: Number(url.searchParams.get('fetch')) || 4 })) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, results: [] });
    }
  }
  if (p === '/api/download' && method === 'POST') {
    const body = await readBody(req);
    const webLib = require('./lib/web');
    try {
      const dest = String(body.path || '').replace(/\\/g, '/');
      const out = await webLib.downloadUrl(String(body.url || ''), {
        destDir: dest ? (require('node:path').posix.dirname(dest) === '.' ? '' : require('node:path').posix.dirname(dest)) : undefined,
        filename: dest ? require('node:path').posix.basename(dest) : body.filename,
        overwrite: !!body.overwrite,
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  // ---- files ----
  if (p === '/api/files' && method === 'GET') {
    const dirPath = url.searchParams.get('path') || '.';
    const abs = ws.safeResolve(dirPath);
    return json(res, 200, { files: ws.listDir(abs, { recursive: false }), cwd: ws.rel(abs) });
  }
  if (p === '/api/file' && method === 'GET') {
    const f = ws.readFile(url.searchParams.get('path') || '');
    return json(res, 200, f);
  }
  if (p === '/api/file' && method === 'POST') {
    const body = await readBody(req);
    const r = ws.writeFile(body.path, body.content);
    return json(res, 200, r);
  }
  if (p === '/api/file' && method === 'DELETE') {
    const body = await readBody(req);
    const r = ws.deleteFile(body.path);
    return json(res, 200, r);
  }

  // ---- logs ----
  if (p === '/api/logs' && method === 'GET') {
    return json(res, 200, { log: log.tail(Number(url.searchParams.get('lines')) || 200) });
  }

  // ---- automation browser (visible Chromium the agent drives) ----
  if (p === '/api/browser/open' && method === 'POST') {
    if (!browser.havePlaywright()) {
      return json(res, 200, { ok: false, error: 'playwright not installed — run: npm install playwright && npx playwright install chromium' });
    }
    try {
      const { page } = await browser.ensureBrowser({ headless: false });
      if (!/studio\.youtube\.com/.test(page.url())) {
        await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      return json(res, 200, { ok: true, url: page.url(), auth: browser.authInfo() });
    } catch (e) {
      log.warn('browser', 'open failed', e);
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/browser/close' && method === 'POST') {
    const r = await browser.closeBrowser();
    return json(res, 200, { ok: true, ...r });
  }

  // ---- quit ----
  if (p === '/api/quit' && method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 150);
    return;
  }

  return json(res, 404, { error: 'not found' });
}

// ---- localhost API hardening -----------------------------------------------------------------
// The server holds powerful capabilities (run commands, edit files, upload to YouTube). It binds
// to 127.0.0.1 by default, but a browser can still be tricked by DNS-rebinding or a cross-site
// request into hitting it. So every /api/* and /auth/* request must prove it is same-origin:
//   - Host header hostname must be a loopback name (or the explicitly configured bind host);
//   - an Origin header, when present, must be an http(s) origin whose host is likewise allowed.
// Requests that fail are rejected with 403 before any handler runs.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Hostnames explicitly permitted in addition to loopback (from --host/HOST, unless it is a wildcard bind). */
function extraAllowedHosts() {
  const set = new Set();
  const h = String(HOST || '').trim().toLowerCase();
  if (h && h !== '0.0.0.0' && h !== '::' && h !== '::0') set.add(h);
  return set;
}

/** True when a raw Host header value (host[:port], may be IPv6) names an allowed host. */
function hostAllowed(hostHeader, extra = extraAllowedHosts()) {
  if (!hostHeader) return false;
  let hostname = String(hostHeader).trim().toLowerCase();
  if (hostname.startsWith('[')) {                      // IPv6 literal, e.g. [::1]:4312
    const end = hostname.indexOf(']');
    if (end >= 0) hostname = hostname.slice(0, end + 1);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon >= 0 && hostname.indexOf(':') === colon) hostname = hostname.slice(0, colon); // strip single :port
  }
  return LOOPBACK_HOSTS.has(hostname) || extra.has(hostname);
}

/** True when an Origin header value is an allowed http(s) origin. Empty origin is accepted (same-origin/non-CORS). */
function originAllowed(origin, extra = extraAllowedHosts()) {
  if (!origin) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return hostAllowed(u.host, extra);
}

/** The gate applied to /api/* and /auth/* before routing. Exported for tests. */
function requestAllowed(headers = {}) {
  return hostAllowed(headers.host) && originAllowed(headers.origin);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      if (!requestAllowed(req.headers)) {
        log.warn('server', `rejected cross-origin ${req.method} ${url.pathname} (host=${req.headers.host || '-'} origin=${req.headers.origin || '-'})`);
        return json(res, 403, { error: 'forbidden: request did not originate from the local app' });
      }
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    // static
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (serveAsset(res, 'index.html', MIME['.html'])) return;
      return json(res, 500, { error: 'index.html missing' });
    }
    const base = path.basename(url.pathname);
    if (['app.js', 'markdown.js'].includes(base) && serveAsset(res, base, MIME['.js'])) return;
    if (base === 'style.css' && serveAsset(res, base, MIME['.css'])) return;
    if (base === 'favicon.svg' && serveAsset(res, base, MIME['.svg'])) return;
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log.error('server', `${req.method} ${url.pathname} failed`, e);
    if (!res.headersSent) json(res, statusFor(e), { error: e.message });
    else try { res.end(); } catch { /* ignore */ }
  }
});

// ---- CLI ----
function parseArgs(argv) {
  const out = { port: PORT, host: HOST, dir: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--dir' || a === '-d') out.dir = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '--version' || a === '-v') { out.version = true; }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `agent-forge-studio — agentic YouTube studio for Ollama & OpenAI-compatible APIs

Usage: agent-forge-studio [options]

Options:
  -d, --dir <path>     channel workspace directory (default: cwd)
  -p, --port <n>       port (default ${PORT})
      --host <h>       bind host (default ${HOST})
      --no-open        do not open the browser
  -v, --version        print version
  -h, --help           this help

Command line (no UI):
  agent-forge-studio run "<task>"          one agent task
  agent-forge-studio chat                  interactive agent session
  agent-forge-studio research "<query>"    search + read the web
  agent-forge-studio download <url> [path]
  agent-forge-studio skills list|search|repo|install|remove
  agent-forge-studio browser open|snapshot|navigate|download|close
  Run "agent-forge-studio help" for the full CLI help.

Environment:
  YOUTUBE_STUDIO_HOME  studio data root (default ~/.ytstudio)
  PORT, HOST           same as --port/--host
  GITHUB_TOKEN         optional: higher GitHub API limits for skill discovery
`;

async function main() {
  const argv = process.argv.slice(2);
  const cli = require('./lib/cli');
  if (cli.handles(argv)) {
    try {
      await cli.run(argv);
      return;
    } catch (e) {
      console.error(e.message || e);
      process.exitCode = 1;
      return;
    }
  }
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) {
    let ver = '1.0.0';
    try { ver = JSON.parse(fs.readFileSync(path.join(cfgLib.APP_ROOT || '.', 'package.json'), 'utf8')).version || ver; } catch { /* SEA build */ }
    process.stdout.write(ver + '\n');
    return;
  }
  if (args.dir) cfgLib.setWorkDir(args.dir);
  else cfgLib.setWorkDir(process.cwd());
  tightenSecrets();

  await new Promise((resolve, reject) => {
    server.once('error', (e) => { log.error('server', 'listen failed', e); reject(e); });
    server.listen(args.port, args.host, resolve);
  });
  const where = `http://${args.host}:${server.address().port}`;
  log.info('server', `listening on ${where} (workspace: ${cfgLib.getWorkDir()})`);
  console.log(`agent-forge-studio  →  ${where}`);
  console.log(`workspace             →  ${cfgLib.getWorkDir()}`);
  if (args.open) {
    const cmd = process.platform === 'darwin' ? `open ${where}` : process.platform === 'win32' ? `start ${where}` : `xdg-open ${where} 2>/dev/null || true`;
    exec(cmd, () => {});
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}


function tightenSecrets() {
  try {
    const root = cfgLib.studioDir ? cfgLib.studioDir() : null;
    if (!root) return;
    ensureSecretDir(root);
    const tightenTree = (dir) => {
      ensureSecretDir(dir);
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const ent of ents) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) { ensureSecretDir(full); stack.push(full); continue; }
          if (!ent.isFile()) continue;
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (!((st.mode & 0o777) & 0o077)) continue;
          try {
            fs.chmodSync(full, 0o600);
            log.warn('server', `tightened permissions on ${full} to 0600`);
          } catch (e) {
            if (process.platform !== 'win32') log.warn('server', `failed to tighten permissions on ${full}`, e);
          }
        }
      }
    };
    const projectJson = path.join(root, 'project.json');
    try {
      const st = fs.statSync(projectJson);
      if ((st.mode & 0o777) & 0o077) {
        fs.chmodSync(projectJson, 0o600);
        log.warn('server', `tightened permissions on ${projectJson} to 0600`);
      }
    } catch { /* not present */ }
    for (const name of ['config', 'browser']) {
      const dir = path.join(root, name);
      if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) tightenTree(dir);
    }
  } catch (e) {
    if (process.platform !== 'win32') log.debug('server', 'secret tightening failed', e);
  }
}

module.exports = { server, handleApi, requestAllowed, parseCookies, hostAllowed, originAllowed };
