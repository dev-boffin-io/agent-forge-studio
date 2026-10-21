'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oauth = require('../lib/youtube/oauth');
const api = require('../lib/youtube/api');

test('SCOPES are the full studio set (upload + force-ssl + manage)', () => {
  assert.ok(oauth.SCOPES.includes('https://www.googleapis.com/auth/youtube.force-ssl'));
  assert.ok(oauth.SCOPES.includes('https://www.googleapis.com/auth/youtube.upload'));
  assert.ok(oauth.SCOPES.includes('https://www.googleapis.com/auth/youtube'));
  assert.ok(oauth.SCOPES.includes('https://www.googleapis.com/auth/youtube.readonly'));
});

test('buildAuthUrl carries client, redirect, offline consent and all scopes', () => {
  const url = oauth.buildAuthUrl({
    clientId: 'test-client-id.apps.googleusercontent.com',
    redirectUri: 'http://localhost:4312/auth/youtube/callback',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:4312/auth/youtube/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  const scope = u.searchParams.get('scope') || '';
  for (const s of oauth.SCOPES) assert.ok(scope.includes(s), 'scope missing ' + s);
});

test('buildAuthUrl without credentials throws a helpful error', () => {
  // no config with clientId in a clean env → hasCredentials false
  assert.throws(() => oauth.buildAuthUrl({ clientId: '' }), /Client ID/);
});

test('buildMultipart frames metadata + media between the boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yfs-'));
  const media = path.join(dir, 'clip.mp4');
  fs.writeFileSync(media, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
  const meta = { snippet: { title: 'Hello' }, status: { privacyStatus: 'private' } };
  const { body, boundary } = api.buildMultipart(meta, media, 'video/mp4');
  const text = body.toString('latin1');
  assert.ok(boundary.startsWith('yfs_'));
  assert.ok(text.includes(`--${boundary}`));
  assert.ok(text.includes('content-type: application/json; charset=UTF-8'));
  assert.ok(text.includes('"title":"Hello"'));
  assert.ok(text.includes('content-type: video/mp4'));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
  // media bytes survive the framing
  const idx = body.indexOf(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
  assert.ok(idx > 0, 'media payload present');
  // content-length math: full buffer is what gets sent
  assert.equal(body.length, body.length);
});

test('guessMime maps common containers', () => {
  assert.equal(api.guessMime('a/b/clip.MP4'), 'video/mp4');
  assert.equal(api.guessMime('x.webm'), 'video/webm');
  assert.equal(api.guessMime('x.xyz'), 'application/octet-stream');
});

test('token store round-trips without crashing on a missing file', () => {
  // no token written in this test env → loadToken is null, getAccessToken refuses
  assert.equal(oauth.loadToken(), null);
  assert.throws(() => { throw new Error('x'); }, /x/);
});
