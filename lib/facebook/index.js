'use strict';

// Facebook Pages OAuth + token lifecycle. Tokens live in the studio data dir with 0600 perms.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { writeSecretFile } = require('../secret-store');
const { createState, verifyState } = require('../oauth-state');
const { fetchOk } = require('../errors');

const VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const AUTH_URL = `https://www.facebook.com/${VERSION}/dialog/oauth`;
const TOKEN_URL = `${GRAPH}/oauth/access_token`;
const TOKEN_SKEW_MS = 60 * 1000;
const LONG_LIVED_FALLBACK_MS = 60 * 24 * 60 * 60 * 1000;

const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
];

function tokenPath() {
  return path.join(config.studioDir(), 'config', 'facebook_token.json');
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(tokenPath(), 'utf8')); } catch { return null; }
}

function saveToken(t) {
  writeSecretFile(tokenPath(), JSON.stringify(t, null, 2));
  return t;
}

function clearToken() {
  try { fs.unlinkSync(tokenPath()); return true; } catch { return false; }
}

function hasCredentials(cfgIn) {
  const c = cfgIn || config.loadConfig();
  return !!(c.facebook && c.facebook.clientId && c.facebook.clientSecret);
}

function redirectUri({ port } = {}) {
  const c = config.loadConfig();
  if (c.facebook && c.facebook.redirectUri) return c.facebook.redirectUri;
  const p = Number(port) || Number(process.env.PORT) || 4312;
  return process.env.FACEBOOK_REDIRECT_URI || `http://localhost:${p}/auth/facebook/callback`;
}

function buildAuthUrl({ clientId, redirectUri: rd, scopes = SCOPES, state } = {}) {
  const c = config.loadConfig();
  const id = clientId || (c.facebook && c.facebook.clientId);
  if (!id) throw new Error('Facebook Client ID is not configured — add it in Providers → Facebook Agent Credentials');
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', rd || redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(','));
  u.searchParams.set('state', state || createState());
  return u.toString();
}

async function tokenRequest(params, source) {
  const res = await fetchOk(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  }, { source, where: 'graph.facebook.com' });
  return res.json();
}

function credentials() {
  const c = config.loadConfig().facebook || {};
  if (!c.clientId || !c.clientSecret) throw new Error('Facebook credentials are not configured — add them in Providers');
  return c;
}

async function exchangeCode(code, { redirectUri: rd } = {}) {
  const c = credentials();
  const data = await tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: rd || redirectUri(),
    code,
  }, 'facebook OAuth');
  if (!data.access_token) throw new Error('Facebook token exchange returned no access token');
  return data;
}

async function exchangeLongLived(shortToken) {
  const c = credentials();
  const data = await tokenRequest({
    grant_type: 'fb_exchange_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    fb_exchange_token: shortToken,
  }, 'facebook long-lived token');
  if (!data.access_token) throw new Error('Facebook long-lived token exchange returned no access token');
  return data;
}

async function fetchAccounts(userToken) {
  const u = new URL(`${GRAPH}/me/accounts`);
  u.searchParams.set('fields', 'id,name,access_token');
  const res = await fetchOk(u, {
    headers: { authorization: `Bearer ${userToken}`, accept: 'application/json' },
  }, { source: 'facebook pages', where: 'graph.facebook.com' });
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

async function completeAuthorization(code, { redirectUri: rd } = {}) {
  const short = await exchangeCode(code, { redirectUri: rd });
  const long = await exchangeLongLived(short.access_token);
  const accounts = await fetchAccounts(long.access_token);
  const pages = {};
  const pageNames = {};
  for (const page of accounts) {
    if (!page || !page.id) continue;
    if (page.access_token) pages[page.id] = page.access_token;
    if (page.name) pageNames[page.id] = page.name;
  }
  return saveToken({
    access_token: long.access_token,
    token_type: long.token_type || short.token_type || 'bearer',
    scope: long.scope || short.scope || SCOPES.join(','),
    expires_at: Date.now() + (Number(long.expires_in) || Number(short.expires_in) || LONG_LIVED_FALLBACK_MS / 1000) * 1000,
    obtained_at: new Date().toISOString(),
    pages,
    page_names: pageNames,
  });
}

async function refreshToken() {
  const t = loadToken();
  if (!t || !t.access_token) throw new Error('Facebook is not connected — press Connect Agent in Providers');
  const refreshed = await exchangeLongLived(t.access_token);
  let accounts = [];
  try { accounts = await fetchAccounts(refreshed.access_token); } catch { /* keep existing page tokens */ }
  const pages = { ...(t.pages || {}) };
  const pageNames = { ...(t.page_names || {}) };
  for (const page of accounts) {
    if (!page || !page.id) continue;
    if (page.access_token) pages[page.id] = page.access_token;
    if (page.name) pageNames[page.id] = page.name;
  }
  return saveToken({
    ...t,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || t.token_type,
    scope: refreshed.scope || t.scope,
    expires_at: Date.now() + (Number(refreshed.expires_in) || LONG_LIVED_FALLBACK_MS / 1000) * 1000,
    refreshed_at: new Date().toISOString(),
    pages,
    page_names: pageNames,
  });
}

async function getValidToken() {
  const t = loadToken();
  if (!t || !t.access_token) throw new Error('Facebook is not connected — press Connect Agent in Providers');
  if (t.expires_at && Date.now() < t.expires_at - TOKEN_SKEW_MS) return t.access_token;
  try {
    const next = await refreshToken();
    return next.access_token;
  } catch (e) {
    throw new Error(`Facebook session expired — reconnect the agent (${e.message})`);
  }
}

function status() {
  const t = loadToken();
  const c = config.loadConfig();
  const pages = t && t.pages ? Object.keys(t.pages) : [];
  const first = pages[0];
  return {
    hasCredentials: hasCredentials(c),
    hasToken: !!t,
    accountName: (first && t.page_names && t.page_names[first]) || null,
    pages: pages.map((id) => ({ id, name: (t.page_names && t.page_names[id]) || null })),
    scopes: (t && t.scope) ? String(t.scope).split(/[ ,]+/).filter(Boolean) : SCOPES,
    obtainedAt: (t && (t.refreshed_at || t.obtained_at)) || null,
    expiresAt: (t && t.expires_at) || null,
  };
}

module.exports = {
  VERSION, GRAPH, AUTH_URL, TOKEN_URL, SCOPES,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials, redirectUri, buildAuthUrl, exchangeCode, exchangeLongLived,
  fetchAccounts, completeAuthorization, refreshToken, getValidToken, status,
  createState, verifyState,
};
