'use strict';
// End-to-end smoke test: actually boot server.js and talk to its HTTP API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], {
      env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home, YOUTUBE_STUDIO_HOME: ctx.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start in time:\n' + out)); }, 20000);
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/(?:listening on|→\s*)http:\/\/([^:/\s]+):(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[2]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

test('server boots, serves the UI and answers the HTTP API', async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;

  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.workDir, fs.realpathSync(ctx.dir));

  const agents = await (await fetch(base + '/api/agents')).json();
  assert.ok(Array.isArray(agents.agents));
  assert.ok(agents.agents.some((a) => a.id === 'create' && a.primary));
  assert.ok(agents.agents.some((a) => a.id === 'scout' && a.subagent));

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<html'));

  assert.ok(config.endpoint);

  const sessionsRes = await fetch(base + '/api/sessions');
  assert.equal(sessionsRes.status, 200);
  const list = await sessionsRes.json();
  assert.ok(Array.isArray(list.sessions));

  const missing = await fetch(base + '/api/nope');
  assert.ok([400, 404].includes(missing.status), `unexpected status ${missing.status}`);
});

// raw HTTP request so we can set a forbidden header (Host) that fetch() refuses to send
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server rejects cross-origin / non-loopback API requests (403)', async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;

  // baseline: a normal same-origin request is allowed
  assert.equal((await fetch(base + '/api/config')).status, 200);

  // a cross-origin Origin header is rejected
  const evilOrigin = await fetch(base + '/api/config', { headers: { origin: 'http://evil.com' } });
  assert.equal(evilOrigin.status, 403);

  // a spoofed Host header (DNS rebinding) is rejected — fetch() can't set Host, so go raw
  assert.equal((await rawGet(port, '/api/config', { host: 'evil.com' })).status, 403);

  // both bad at once, and a bad one on an /auth/ route, are rejected too
  assert.equal((await rawGet(port, '/api/sessions', { host: 'evil.com', origin: 'http://evil.com' })).status, 403);
  assert.equal((await rawGet(port, '/auth/youtube/callback?code=x&state=y', { host: 'evil.com' })).status, 403);
});

test('server rejects an OAuth callback with a missing or invalid state (CSRF)', async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  // no state at all → rejected before any token exchange
  assert.equal((await fetch(base + '/auth/youtube/callback?code=x')).status, 400);
  // a state we never issued → rejected
  assert.equal((await fetch(base + '/auth/youtube/callback?code=x&state=forged.state.value')).status, 400);
});
