'use strict';

// Google APIs adapter (placeholder structure for Google services management).
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, studioDir } = require('../config');

const SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
];

function tokenPath() {
  return path.join(studioDir(), 'config', 'google_token.json');
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(tokenPath(), 'utf8')); } catch { return null; }
}

function saveToken(t) {
  const p = tokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(t, null, 2), 'utf8');
}

function clearToken() {
  try { fs.unlinkSync(tokenPath()); return true; } catch { return false; }
}

function hasCredentials(cfgIn) {
  const c = cfgIn || loadConfig();
  return !!(c.google && c.google.clientId && c.google.clientSecret);
}

module.exports = {
  SCOPES,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials,
};
