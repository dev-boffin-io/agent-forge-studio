'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setup } = require('./helpers');
setup();

const cfg = require('../lib/config');
const fb = require('../lib/facebook');
const api = require('../lib/facebook/api');

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

test('facebook: auth URL carries scopes, redirect and state', () => {
  const url = fb.buildAuthUrl({
    clientId: 'fb-app-id',
    redirectUri: 'http://localhost:4312/auth/facebook/callback',
    state: 'signed.state.value',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v23.0/dialog/oauth');
  assert.equal(u.searchParams.get('client_id'), 'fb-app-id');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:4312/auth/facebook/callback');
  assert.equal(u.searchParams.get('state'), 'signed.state.value');
  const scope = u.searchParams.get('scope') || '';
  for (const s of fb.SCOPES) assert.ok(scope.includes(s), 'scope missing ' + s);
});

test('facebook: state is single-use, expiring and tamper-proof', () => {
  const state = fb.createState();
  assert.equal(fb.verifyState(state), true);
  assert.equal(fb.verifyState(state), false, 'replayed state must fail');
  assert.equal(fb.verifyState('forged.state.value'), false);
  assert.equal(fb.verifyState(''), false);

  const now = Date.now();
  const old = fb.createState(now);
  assert.equal(fb.verifyState(old, now + 11 * 60 * 1000), false, 'expired state must fail');

  const fresh = fb.createState();
  const parts = fresh.split('.');
  parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A');
  assert.equal(fb.verifyState(parts.join('.')), false, 'tampered signature must fail');
});

test('facebook: callback exchanges code, long-lived token and page tokens (0600)', async (t) => {
  if (process.platform === 'win32') t.skip('mode bits are not POSIX on Windows');
  const seen = [];
  await withMockFetch(async (url, opts) => {
    seen.push({ url: String(url), opts });
    if (seen.length === 1) return jsonResponse({ access_token: 'short-token' });
    if (seen.length === 2) return jsonResponse({ access_token: 'long-token', expires_in: 5184000 });
    return jsonResponse({ data: [{ id: 'page-1', name: 'My Page', access_token: 'page-token' }] });
  }, async () => {
    const orig = cfg.loadConfig;
    cfg.loadConfig = () => ({ facebook: { clientId: 'fb-app-id', clientSecret: 'fb-secret' } });
    try {
      const token = await fb.completeAuthorization('auth-code', { redirectUri: 'http://localhost:4312/auth/facebook/callback' });
      assert.equal(token.access_token, 'long-token');
      assert.equal(token.pages['page-1'], 'page-token');
      assert.equal(token.page_names['page-1'], 'My Page');
    } finally { cfg.loadConfig = orig; }
  });
  const first = new URL(seen[0].url);
  assert.equal(first.host, 'graph.facebook.com');
  assert.equal(new URLSearchParams(seen[0].opts.body).get('code'), 'auth-code');
  assert.equal(new URLSearchParams(seen[1].opts.body).get('grant_type'), 'fb_exchange_token');
  const accounts = new URL(seen[2].url);
  assert.equal(accounts.searchParams.get('access_token'), null);
  assert.equal(seen[2].opts.headers.authorization, 'Bearer long-token');
  assert.equal(fs.statSync(fb.tokenPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(fb.tokenPath())).mode & 0o777, 0o700);
});


test('facebook: expired user token refreshes and updates page tokens', async () => {
  fb.saveToken({ access_token: 'old-user', pages: { p1: 'old-page' }, expires_at: Date.now() - 1000 });
  const orig = cfg.loadConfig;
  cfg.loadConfig = () => ({ facebook: { clientId: 'fb-app-id', clientSecret: 'fb-secret' } });
  const calls = [];
  try {
    await withMockFetch(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (calls.length === 1) return jsonResponse({ access_token: 'new-user', expires_in: 5184000 });
      return jsonResponse({ data: [{ id: 'p1', name: 'Page', access_token: 'new-page' }] });
    }, async () => {
      assert.equal(await fb.getValidToken(), 'new-user');
    });
  } finally { cfg.loadConfig = orig; }
  assert.equal(new URLSearchParams(calls[0].opts.body).get('grant_type'), 'fb_exchange_token');
  assert.equal(fb.loadToken().pages.p1, 'new-page');
  assert.equal(fb.loadToken().access_token, 'new-user');
});

test('facebook: publish uses Bearer page token and never puts access_token in the URL', async () => {
  fb.saveToken({
    access_token: 'user-token',
    pages: { 'page-1': 'page-token' },
    page_names: { 'page-1': 'My Page' },
    expires_at: Date.now() + 3600_000,
  });
  let seen;
  await withMockFetch(async (url, opts) => {
    seen = { url: String(url), opts };
    return jsonResponse({ id: 'page-1_123' });
  }, async () => {
    const out = await api.publishText({ message: 'hello world' });
    assert.equal(out.id, 'page-1_123');
  });
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer page-token');
  assert.ok(!seen.url.includes('access_token'), 'token must not be in the URL');
  assert.equal(new URL(seen.url).pathname, '/v23.0/page-1/feed');
  assert.equal(new URLSearchParams(seen.opts.body).get('message'), 'hello world');
});

test('facebook: publish rejects non-https media URLs', async () => {
  await assert.rejects(() => api.publishPhoto({ photoUrl: 'http://example.com/a.jpg' }), /https URL/);
});
