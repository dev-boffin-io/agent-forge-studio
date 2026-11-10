'use strict';

// OAuth connect/callback routes for YouTube, Instagram, Facebook and Google.
// The OAuth `state` is a signed single-use nonce, also bound to an HttpOnly cookie.

const cfg = require('./config');

const PROVIDERS = {
  youtube: { mod: () => require('./youtube/oauth'), label: 'YouTube', cookie: 'yt_oauth_state', success: 'Full studio scopes granted. You can close this tab and return to Agent Forge Studio.' },
  instagram: { mod: () => require('./instagram'), label: 'Instagram', cookie: 'ig_oauth_state', success: 'Instagram Business/Creator connected. You can close this tab and return to Agent Forge Studio.' },
  facebook: { mod: () => require('./facebook'), label: 'Facebook', cookie: 'fb_oauth_state', success: 'Pages connected. You can close this tab and return to Agent Forge Studio.' },
  google: { mod: () => require('./google'), label: 'Google', cookie: 'g_oauth_state', success: 'Google account connected. You can close this tab and return to Agent Forge Studio.' },
  github: { mod: () => require('./github'), label: 'GitHub', cookie: 'gh_token', success: 'GitHub token saved. You can close this tab and return to Agent Forge Studio.' },
};

const escapeHtmlHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function page(res, status, provider, message) {
  const ok = status === 200;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent Forge Studio</title>
<style>body{background:#0f0f0f;color:#f1f1f1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:440px}
.ok{color:#2ba640;font-size:38px}.bad{color:#ff4d4f;font-size:38px}code{color:#ff6680}</style></head>
<body><div class="card">${ok ? '<div class="ok">✓</div><h2>' + escapeHtmlHtml(provider) + ' agent connected</h2>' : '<div class="bad">✗</div><h2>Connection failed</h2>'}
<p style="color:#aaa">${ok ? escapeHtmlHtml(provider === 'YouTube' ? PROVIDERS.youtube.success : (message || 'You can close this tab and return to Agent Forge Studio.')) : escapeHtmlHtml(message || 'no code returned')}</p></div></body></html>`);
}

function cookies(req, parseCookies) {
  if (typeof parseCookies === 'function') return parseCookies(req);
  const out = {};
  for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setStateCookie(res, name, value, path, maxAge = 600) {
  res.setHeader('set-cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`);
}

async function handle(req, res, url, { port, sendJson, parseCookies, log }) {
  const m = /^\/auth\/(youtube|instagram|facebook|google)\/(connect|callback)$/.exec(url.pathname);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  const [, id, action] = m;
  const p = PROVIDERS[id];
  const mod = p.mod();
  if (action === 'connect') {
    try {
      const state = mod.createState();
      setStateCookie(res, p.cookie, state, `/auth/${id}/callback`);
      const redirectUri = id === 'youtube' ? mod.redirectUri(req) : mod.redirectUri({ port });
      return redirect(res, mod.buildAuthUrl({ redirectUri, state }));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const cookieState = cookies(req, parseCookies)[p.cookie] || '';
  setStateCookie(res, p.cookie, '', `/auth/${id}/callback`, 0);
  if (!state || !cookieState || state !== cookieState || !mod.verifyState(state)) {
    log && log.warn(id, 'OAuth callback rejected: state missing or mismatched');
    return page(res, 400, p.label, 'invalid or expired OAuth state — start the connection again from the app');
  }
  if (err) return page(res, 400, p.label, err);
  if (!code) return page(res, 400, p.label, 'no authorization code in the callback');
  try {
    const redirectUri = id === 'youtube' ? mod.redirectUri(req) : mod.redirectUri({ port });
    if (typeof mod.completeAuthorization === 'function') await mod.completeAuthorization(code, { redirectUri });
    else await mod.exchangeCode(code, { redirectUri });
    return page(res, 200, p.label, p.success);
  } catch (e) {
    log && log.error(id, 'OAuth callback failed', e);
    return page(res, 400, p.label, e.message);
  }
}

async function handleApi(req, res, url, { port, sendJson, readBody, log }) {
  const m = /^\/api\/(youtube|instagram|facebook|google|github)\/(connect|status|credentials)$/.exec(url.pathname);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  const [, id, action] = m;
  const p = PROVIDERS[id];
  const mod = p.mod();

  try {
    if (id === 'github') {
      if (action === 'status') return sendJson(res, 200, mod.status());
      if (action === 'credentials') {
        const body = await readBody(req);
        cfg.saveConfig({ github: { token: String(body.token || body.clientSecret || '').trim(), apiBase: body.apiBase } });
        return sendJson(res, 200, require('./llm').maskConfig(cfg.loadConfig()));
      }
      return sendJson(res, 400, { error: 'GitHub uses a personal access token. Save a token in Providers → GitHub Agent Credentials.' });
    }

    if (action === 'status') {
      if (id === 'youtube') {
        const c = cfg.loadConfig();
        const t = mod.loadToken();
        return sendJson(res, 200, {
          hasCredentials: mod.hasCredentials(c), hasToken: !!t,
          obtainedAt: (t && (t.refreshed_at || t.obtained_at)) || null,
          scopes: (t && t.scope) ? String(t.scope).split(' ') : mod.SCOPES,
        });
      }
      return sendJson(res, 200, mod.status());
    }

    if (action === 'credentials') {
      const body = await readBody(req);
      const patch = { [id]: { clientId: String(body.clientId || '').trim(), clientSecret: String(body.clientSecret || '').trim(), redirectUri: String(body.redirectUri || '').trim() } };
      cfg.saveConfig(patch);
      return sendJson(res, 200, cfg.loadConfig());
    }

    const state = mod.createState();
    setStateCookie(res, p.cookie, state, `/auth/${id}/callback`);
    const redirectUri = id === 'youtube' ? mod.redirectUri(req) : mod.redirectUri({ port });
    const authUrl = mod.buildAuthUrl({ redirectUri, state });
    if (req.method === 'GET') return redirect(res, authUrl);
    return sendJson(res, 200, { ok: true, url: authUrl });
  } catch (e) {
    log && log.error(id, 'OAuth connect failed', e);
    return sendJson(res, 400, { error: e.message });
  }
}

module.exports = { handle, handleApi, PROVIDERS };
