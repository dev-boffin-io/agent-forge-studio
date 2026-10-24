'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeSecretFile } = require('../lib/secret-store');

test('secret files get 0600 and directory 0700', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-secret-'));
  const file = path.join(dir, 'sub', 'token.json');
  writeSecretFile(file, '{}');
  const dstat = fs.statSync(path.dirname(file));
  const fstat = fs.statSync(file);
  assert.equal(dstat.mode & 0o777, 0o700);
  assert.equal(fstat.mode & 0o777, 0o600);
});

test('existing 0644 file is tightened to 0600', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-secret-'));
  const file = path.join(dir, 'token.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writeSecretFile(file, '{"x":1}');
  const fstat = fs.statSync(file);
  assert.equal(fstat.mode & 0o777, 0o600);
});

test('secureDir:false leaves the parent directory mode alone', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-secret-'));
  const sub = path.join(dir, 'checkout');
  fs.mkdirSync(sub, { mode: 0o755 });
  fs.chmodSync(sub, 0o755);
  const file = path.join(sub, 'config.json');
  writeSecretFile(file, '{}', { secureDir: false });
  assert.equal(fs.statSync(sub).mode & 0o777, 0o755);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
