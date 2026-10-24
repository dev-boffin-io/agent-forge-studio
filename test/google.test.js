'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { setup } = require('./helpers');
setup();

const cfg = require('../lib/config');
const g = require('../lib/google');
const api = require('../lib/google/api');

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

function withBaseConfig(fn) {
  const orig = cfg.loadConfig;
  cfg.loadConfig = () => ({ google: { clientId: 'g-app', clientSecret: 'g-secret' } });
  return Promise.resolve().then(fn).finally(() => { cfg.loadConfig = orig; });
}

test('google: auth URL requests offline access and Business Profile scope', () => {
  const url = g.buildAuthUrl({ clientId: 'g-app', redirectUri: 'http://localhost:4312/auth/google/callback', state: 'state' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  const scope = u.searchParams.get('scope') || '';
  for (const s of g.SCOPES) assert.ok(scope.includes(s), 'scope missing ' + s);
});

test('google: callback stores refresh token, expiry and identity (0600)', async (t) => {
  if (process.platform === 'win32') t.skip('mode bits are not POSIX on Windows');
  g.clearToken();
  await withBaseConfig(() => withMockFetch(async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: g.SCOPES.join(' '), token_type: 'Bearer' });
    }
    return jsonResponse({ id: 'sub-1', email: 'user@example.com', name: 'User' });
  }, async () => {
    const token = await g.completeAuthorization('code', { redirectUri: 'http://localhost:4312/auth/google/callback' });
    assert.equal(token.access_token, 'access-1');
    assert.equal(token.refresh_token, 'refresh-1');
    assert.equal(token.email, 'user@example.com');
  }));
  assert.ok(g.loadToken().expires_at > Date.now());
  assert.equal(fs.statSync(g.tokenPath()).mode & 0o777, 0o600);
});

test('google: expired access token refreshes with refresh_token', async () => {
  g.saveToken({
    access_token: 'old-access',
    refresh_token: 'refresh-1',
    expires_at: Date.now() - 1000,
    obtained_at: new Date().toISOString(),
  });
  let body;
  await withBaseConfig(() => withMockFetch(async (url, opts) => {
    body = opts.body;
    return jsonResponse({ access_token: 'new-access', expires_in: 3600 });
  }, async () => {
    const token = await g.getValidToken();
    assert.equal(token, 'new-access');
  }));
  assert.equal(new URLSearchParams(body).get('grant_type'), 'refresh_token');
  assert.equal(g.loadToken().access_token, 'new-access');
});

test('google: failed refresh tells the user to reconnect', async () => {
  g.saveToken({ access_token: 'old', refresh_token: 'bad', expires_at: Date.now() - 1000 });
  await withBaseConfig(() => withMockFetch(async () => ({
    ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => '{"error":"invalid_grant"}',
  }), async () => {
    await assert.rejects(() => g.getValidToken(), /reconnect the agent/);
  }));
});

test('google: listLocations uses Bearer auth and no token query', async () => {
  g.saveToken({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Date.now() + 3600_000 });
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/accounts') && !String(url).includes('/locations')) {
      return jsonResponse({ accounts: [{ name: 'accounts/1', accountName: 'Acme' }] });
    }
    return jsonResponse({ locations: [{ name: 'locations/9', title: 'Main St' }] });
  }, async () => {
    const items = await api.listLocations();
    assert.equal(items.length, 1);
    assert.equal(items[0].location.title, 'Main St');
  });
  assert.equal(new URL(calls[0].url).host, 'mybusinessaccountmanagement.googleapis.com');
  assert.equal(new URL(calls[1].url).host, 'mybusinessbusinessinformation.googleapis.com');
  for (const c of calls) {
    assert.equal(c.opts.headers.authorization, 'Bearer access-1');
    assert.ok(!c.url.includes('access_token'), 'token must not be in the URL');
  }
});
