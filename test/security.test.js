'use strict';

// Security regression tests for the three hardening fixes:
//   1. publishing to YouTube defaults to "ask" (never implicitly allowed)
//   2. the OAuth flow carries a signed, verifiable `state` (CSRF protection)
//   3. /api/* and /auth/* reject cross-origin / non-loopback requests (DNS rebinding + CSRF)

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const config = require('../lib/config');
const permission = require('../lib/permission');
const oauth = require('../lib/youtube/oauth');
const server = require('../server');

// ---- 1. publish permission ------------------------------------------------------------------

test('security: the default publish permission is "ask", never "allow"', () => {
  assert.equal(config.DEFAULT_CONFIG.permission.publish, 'ask');
  // and it survives a config load with no local override
  assert.equal(config.loadConfig().permission.publish, 'ask');
});

test('security: publish resolves to ask when unset, and cannot be implicitly allowed', () => {
  assert.equal(permission.decide({}, 'publish', 'yt_upload').decision, 'ask');
  assert.equal(permission.decide({ publish: 'allow' }, 'publish', 'yt_upload').decision, 'ask');
  assert.equal(permission.decide({ publish: { '*': 'allow' } }, 'publish', 'yt_set_visibility').decision, 'ask');
  // legacy aliases for the same capability are equally protected
  assert.equal(permission.decide({ yt_upload: 'allow' }, 'yt_upload', '').decision, 'ask');
});

test('security: publish can be made stricter (deny) but other categories are unaffected', () => {
  assert.equal(permission.decide({ publish: 'deny' }, 'publish', '').decision, 'deny');
  assert.equal(permission.decide({ edit: 'allow' }, 'edit', '').decision, 'allow');
  assert.equal(permission.decide({}, 'edit', '').decision, 'ask');
});

test('security: the publish gate still asks the human through makeGate', async () => {
  let asked = null;
  const gate = permission.makeGate({ publish: 'ask' }, async (info) => { asked = info; return false; });
  const res = await gate('publish', 'yt_upload', 'yt_upload');
  assert.equal(res.ok, false);
  assert.equal(asked.category, 'publish');
  // an implicit "allow" is downgraded, so the handler is still consulted
  let askedAgain = false;
  const gate2 = permission.makeGate({ publish: 'allow' }, async () => { askedAgain = true; return true; });
  const res2 = await gate2('publish', 'yt_upload', 'yt_upload');
  assert.equal(askedAgain, true, 'the human is asked even if a config tries to allow publish');
  assert.equal(res2.ok, true);
});

// ---- 2. OAuth CSRF state --------------------------------------------------------------------

test('security: createState/verifyState round-trips and rejects tampering', () => {
  const s = oauth.createState();
  assert.match(s, /^\d+\.[\w-]+\.[\w-]+$/);
  assert.equal(oauth.verifyState(s), true);
  assert.equal(oauth.verifyState(`${s}x`), false, 'appended bytes are rejected');
  assert.equal(oauth.verifyState(s.slice(0, -2) + 'zz'), false, 'a flipped signature is rejected');
  assert.equal(oauth.verifyState(''), false);
  assert.equal(oauth.verifyState(undefined), false);
  assert.equal(oauth.verifyState('not.a.state'), false);
});

test('security: a state expires after its TTL', () => {
  const s = oauth.createState();
  assert.equal(oauth.verifyState(s, Date.now() + 11 * 60 * 1000), false);
});

test('security: two states differ (random nonce) but both verify', () => {
  const a = oauth.createState();
  const b = oauth.createState();
  assert.notEqual(a, b);
  assert.equal(oauth.verifyState(a), true);
  assert.equal(oauth.verifyState(b), true);
});

test('security: buildAuthUrl always includes a verifiable state', () => {
  const url = new URL(oauth.buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://localhost:4312/auth/youtube/callback' }));
  const state = url.searchParams.get('state');
  assert.ok(state, 'a state is present');
  assert.equal(oauth.verifyState(state), true);
  // an explicit state is honoured (so the server can bind it to a cookie)
  const fixed = oauth.createState();
  const url2 = new URL(oauth.buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', state: fixed }));
  assert.equal(url2.searchParams.get('state'), fixed);
});

// ---- 3. Host / Origin validation ------------------------------------------------------------

test('security: requestAllowed accepts loopback hosts (with or without port, IPv4/IPv6/name)', () => {
  for (const host of ['127.0.0.1:4312', 'localhost:4312', 'localhost', '[::1]:4312', '127.0.0.1']) {
    assert.equal(server.requestAllowed({ host }), true, host);
  }
});

test('security: requestAllowed rejects non-loopback or missing Host (DNS rebinding)', () => {
  for (const host of ['evil.com:4312', 'example.org', '10.0.0.5:4312', '', undefined]) {
    assert.equal(server.requestAllowed({ host }), false, String(host));
  }
  assert.equal(server.requestAllowed({}), false, 'no headers at all is rejected');
});

test('security: requestAllowed blocks cross-origin requests but allows same-origin', () => {
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312', origin: 'http://127.0.0.1:4312' }), true);
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312', origin: 'http://localhost:4312' }), true);
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312' }), true, 'a missing Origin is a same-origin/non-CORS request');
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312', origin: 'http://evil.com' }), false);
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312', origin: 'null' }), false);
  assert.equal(server.requestAllowed({ host: '127.0.0.1:4312', origin: 'file:///etc/passwd' }), false);
});

test('security: parseCookies reads the state cookie', () => {
  const cookies = server.parseCookies({ headers: { cookie: 'a=1; yt_oauth_state=abc.def.ghi; b=2' } });
  assert.equal(cookies.a, '1');
  assert.equal(cookies.b, '2');
  assert.equal(cookies.yt_oauth_state, 'abc.def.ghi');
  assert.deepEqual(server.parseCookies({ headers: {} }), {});
});
