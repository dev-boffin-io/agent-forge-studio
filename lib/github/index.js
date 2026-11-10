'use strict';

// GitHub authentication: a personal access token (classic or fine-grained) from config or the
// GITHUB_TOKEN / GH_TOKEN environment. No OAuth flow is needed for CLI-style API access.

const config = require('../config');

const DEFAULT_API = 'https://api.github.com';

function token(cfgIn) {
  const c = cfgIn || config.loadConfig();
  return String((c.github && c.github.token) || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

function apiBase(cfgIn) {
  const c = cfgIn || config.loadConfig();
  const configured = c.github && c.github.apiBase;
  return String(configured || process.env.GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, '');
}

function hasToken(cfgIn) { return !!token(cfgIn); }
function hasCredentials(cfgIn) { return hasToken(cfgIn); }

function tokenSource(cfgIn) {
  const c = cfgIn || config.loadConfig();
  if (c.github && c.github.token) return 'config';
  if (process.env.GITHUB_TOKEN) return 'env:GITHUB_TOKEN';
  if (process.env.GH_TOKEN) return 'env:GH_TOKEN';
  return null;
}

function saveToken(value) {
  config.saveConfig({ github: { token: String(value || '').trim() } });
}

function status(cfgIn) {
  const c = cfgIn || config.loadConfig();
  return {
    hasToken: hasToken(c),
    hasCredentials: hasCredentials(c),
    tokenSource: tokenSource(c),
    apiBase: apiBase(c),
    accountName: (c.github && c.github.accountName) || null,
  };
}

module.exports = { DEFAULT_API, token, apiBase, hasToken, hasCredentials, tokenSource, saveToken, status };
