'use strict';

// Secret storage — token files live in the studio data dir, never in the channel workspace.
// Directories are 0700 and files 0600 so other local users cannot read OAuth tokens.

const fs = require('node:fs');
const path = require('node:path');

function chmodStrict(p, mode) {
  try {
    fs.chmodSync(p, mode);
  } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
}

function ensureSecretDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  chmodStrict(dir, 0o700);
  return dir;
}

function writeSecretFile(filePath, text, { secureDir = true } = {}) {
  if (secureDir) ensureSecretDir(path.dirname(filePath));
  else fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(text), { encoding: 'utf8', mode: 0o600 });
  chmodStrict(filePath, 0o600);
  return filePath;
}

module.exports = { ensureSecretDir, writeSecretFile };
