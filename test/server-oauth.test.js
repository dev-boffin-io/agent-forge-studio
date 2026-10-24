'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const cfg = require('../lib/config');
const fb = require('../lib/facebook');
const { handleApi } = require('../server');

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; },
  };
}

async function call(path, { method = 'GET', cookie = '', host = 'localhost:4312' } = {}) {
  const req = { method, headers: { host, ...(cookie ? { cookie } : {}) } };
  const res = fakeRes();
  await handleApi(req, res, new URL(path, 'http://localhost'));
  return res;
}

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('oauth: GET connect redirects without trusting the Host header', async () => {
  const orig = cfg.loadConfig;
  cfg.loadConfig = () => ({ facebook: { clientId: 'fb-app', clientSecret: 'fb-secret', redirectUri: '' } });
  try {
    const res = await call('/auth/facebook/connect', { host: 'evil.example' });
    assert.equal(res.statusCode, 302);
    const location = res.headers.location;
    const u = new URL(location);
    assert.equal(u.origin, 'https://www.facebook.com');
    const rd = u.searchParams.get('redirect_uri');
    assert.equal(rd, 'http://localhost:4312/auth/facebook/callback');
    assert.ok(!rd.includes('evil.example'));
    assert.ok(res.headers['set-cookie'].includes('fb_oauth_state='));
    assert.ok(res.headers['set-cookie'].includes('HttpOnly'));
  } finally { cfg.loadConfig = orig; }
});

test('oauth: callback rejects missing, forged and replayed state', async () => {
  const orig = cfg.loadConfig;
  const origFetch = global.fetch;
  fb.clearToken();
  cfg.loadConfig = () => ({ facebook: { clientId: 'fb-app', clientSecret: 'fb-secret', redirectUri: '' } });
  try {
    assert.equal((await call('/auth/facebook/callback?code=abc')).statusCode, 400);
    assert.equal((await call('/auth/facebook/callback?error=access_denied')).statusCode, 400);

    const forged = await call('/auth/facebook/callback?code=abc&state=forged.state.value', {
      cookie: 'fb_oauth_state=forged.state.value',
    });
    assert.equal(forged.statusCode, 400);
    assert.match(forged.body, /invalid or expired OAuth state/);

    const state = fb.createState();
    let n = 0;
    global.fetch = async () => {
      n++;
      if (n === 1) return jsonResponse({ access_token: 'short' });
      if (n === 2) return jsonResponse({ access_token: 'long', expires_in: 5184000 });
      return jsonResponse({ data: [{ id: 'p1', name: 'Page', access_token: 'page-token' }] });
    };
    const cookie = `fb_oauth_state=${encodeURIComponent(state)}`;
    const first = await call(`/auth/facebook/callback?code=abc&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /Facebook agent connected/);

    const replay = await call(`/auth/facebook/callback?code=abc&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(replay.statusCode, 400);
    assert.match(replay.body, /invalid or expired OAuth state/);
  } finally {
    cfg.loadConfig = orig;
    global.fetch = origFetch;
    fb.clearToken();
  }
});
