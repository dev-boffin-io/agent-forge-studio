'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const cfg = require('../lib/config');
const ig = require('../lib/instagram');
const api = require('../lib/instagram/api');

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

test('instagram: auth URL includes publishing scopes', () => {
  const url = ig.buildAuthUrl({ clientId: 'ig-app', redirectUri: 'http://localhost:4312/auth/instagram/callback', state: 'state' });
  const u = new URL(url);
  const scope = u.searchParams.get('scope') || '';
  for (const s of ig.SCOPES) assert.ok(scope.includes(s), 'scope missing ' + s);
  assert.ok(scope.includes('instagram_content_publish'));
});

test('instagram: callback resolves the linked business account', async () => {
  const orig = cfg.loadConfig;
  cfg.loadConfig = () => ({ instagram: { clientId: 'ig-app', clientSecret: 'ig-secret' } });
  try {
    let calls = 0;
    await withMockFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ access_token: 'short' });
      if (calls === 2) return jsonResponse({ access_token: 'long', expires_in: 5184000 });
      return jsonResponse({
        data: [{
          id: 'page-1',
          name: 'Business Page',
          access_token: 'page-token',
          instagram_business_account: { id: 'ig-user-1', username: 'studio.account' },
        }],
      });
    }, async () => {
      const token = await ig.completeAuthorization('code', { redirectUri: 'http://localhost:4312/auth/instagram/callback' });
      assert.equal(token.igUserId, 'ig-user-1');
      assert.equal(token.username, 'studio.account');
      assert.equal(token.access_token, 'page-token');
      assert.equal(token.user_access_token, 'long');
    });
  } finally { cfg.loadConfig = orig; }
});

test('instagram: photo publish creates container, polls, then publishes', async () => {
  ig.saveToken({
    access_token: 'page-token',
    user_access_token: 'long-token',
    igUserId: 'ig-user-1',
    username: 'studio.account',
    expires_at: Date.now() + 3600_000,
  });
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (calls.length === 1) return jsonResponse({ id: 'container-1' });
    if (calls.length === 2) return jsonResponse({ status_code: 'FINISHED' });
    return jsonResponse({ id: 'media-1' });
  }, async () => {
    const out = await api.publishPhoto({ imageUrl: 'https://example.com/a.jpg', caption: 'hello' });
    assert.equal(out.id, 'media-1');
  });
  assert.equal(new URL(calls[0].url).pathname, '/v23.0/ig-user-1/media');
  assert.equal(new URL(calls[2].url).pathname, '/v23.0/ig-user-1/media_publish');
  for (const c of calls) {
    assert.equal(c.opts.headers.authorization, 'Bearer page-token');
    assert.ok(!c.url.includes('access_token'), 'token must not be in the URL');
  }
  assert.equal(new URLSearchParams(calls[0].opts.body).get('image_url'), 'https://example.com/a.jpg');
  assert.equal(new URLSearchParams(calls[2].opts.body).get('creation_id'), 'container-1');
});

test('instagram: reel publish times out with a clear error', async () => {
  ig.saveToken({
    access_token: 'page-token',
    user_access_token: 'long-token',
    igUserId: 'ig-user-1',
    expires_at: Date.now() + 3600_000,
  });
  let n = 0;
  await withMockFetch(async () => {
    n++;
    if (n === 1) return jsonResponse({ id: 'container-2' });
    return jsonResponse({ status_code: 'IN_PROGRESS' });
  }, async () => {
    await assert.rejects(
      () => api.publishReel({ videoUrl: 'https://example.com/a.mp4', timeoutMs: 40, intervalMs: 5 }),
      /did not finish processing/,
    );
  });
});

test('instagram: refresh keeps the IG account and page token', async () => {
  ig.saveToken({
    access_token: 'old-page-token',
    user_access_token: 'old-user-token',
    igUserId: 'ig-user-1',
    expires_at: Date.now() - 1000,
  });
  const orig = cfg.loadConfig;
  cfg.loadConfig = () => ({ instagram: { clientId: 'ig-app', clientSecret: 'ig-secret' } });
  const calls = [];
  try {
    await withMockFetch(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (calls.length === 1) return jsonResponse({ access_token: 'new-user-token', expires_in: 5184000 });
      return jsonResponse({ data: [{ id: 'page-1', name: 'Page', access_token: 'new-page-token', instagram_business_account: { id: 'ig-user-1', username: 'u' } }] });
    }, async () => {
      const token = await ig.getValidToken();
      assert.equal(token, 'new-page-token');
    });
  } finally { cfg.loadConfig = orig; }
  const t = ig.loadToken();
  assert.equal(t.user_access_token, 'new-user-token');
  assert.equal(t.igUserId, 'ig-user-1');
});
