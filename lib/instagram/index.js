'use strict';

// Instagram Graph API adapter (placeholder structure). 
// Zero dependencies beyond built-ins; designed to integrate with the platform router.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, studioDir } = require('../config');

const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
];

function tokenPath() {
  return path.join(studioDir(), 'config', 'instagram_token.json');
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
  return !!(c.instagram && c.instagram.clientId && c.instagram.clientSecret);
}

module.exports = {
  SCOPES,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials,
};
