'use strict';

// Google OAuth + token lifecycle for identity and Business Profile reads. Tokens live in the
// studio data dir with 0600 perms and refresh automatically before they expire.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { writeSecretFile } = require('../secret-store');
const { createState, verifyState } = require('../oauth-state');
const { fetchOk } = require('../errors');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SKEW_MS = 60 * 1000;

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/business.manage',
];

function tokenPath() {
  return path.join(config.studioDir(), 'config', 'google_token.json');
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
  return !!(c.google && c.google.clientId && c.google.clientSecret);
}

function redirectUri({ port } = {}) {
  const c = config.loadConfig();
  if (c.google && c.google.redirectUri) return c.google.redirectUri;
  const p = Number(port) || Number(process.env.PORT) || 4312;
  return process.env.GOOGLE_REDIRECT_URI || `http://localhost:${p}/auth/google/callback`;
}

function buildAuthUrl({ clientId, redirectUri: rd, scopes = SCOPES, state } = {}) {
  const c = config.loadConfig();
  const id = clientId || (c.google && c.google.clientId);
  if (!id) throw new Error('Google Client ID is not configured — add it in Providers → Google Agent Credentials');
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', rd || redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state || createState());
  return u.toString();
}

function credentials() {
  const c = config.loadConfig().google || {};
  if (!c.clientId || !c.clientSecret) throw new Error('Google credentials are not configured — add them in Providers');
  return c;
}

async function tokenRequest(params, source) {
  const res = await fetchOk(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  }, { source, where: 'oauth2.googleapis.com' });
  return res.json();
}

async function exchangeCode(code, { redirectUri: rd } = {}) {
  const c = credentials();
  const data = await tokenRequest({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: rd || redirectUri(),
    grant_type: 'authorization_code',
  }, 'google OAuth');
  if (!data.access_token) throw new Error('Google token exchange returned no access token');
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope || SCOPES.join(' '),
    token_type: data.token_type || 'Bearer',
    id_token: data.id_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    obtained_at: new Date().toISOString(),
  };
  saveToken(token);
  return token;
}

async function completeAuthorization(code, { redirectUri: rd } = {}) {
  const token = await exchangeCode(code, { redirectUri: rd });
  let identity = null;
  try {
    const api = require('./api');
    identity = await api.getUserInfo();
  } catch { /* identity is helpful but not required to finish the connection */ }
  return saveToken({
    ...token,
    sub: (identity && identity.id) || null,
    email: (identity && identity.email) || null,
    name: (identity && identity.name) || null,
    picture: (identity && identity.picture) || null,
  });
}

async function refreshToken() {
  const t = loadToken();
  if (!t || !t.refresh_token) throw new Error('Google is not connected — press Connect Agent in Providers');
  const c = credentials();
  const data = await tokenRequest({
    refresh_token: t.refresh_token,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
  }, 'google token refresh');
  if (!data.access_token) throw new Error('Google token refresh returned no access token');
  return saveToken({
    ...t,
    access_token: data.access_token,
    scope: data.scope || t.scope,
    token_type: data.token_type || t.token_type,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refreshed_at: new Date().toISOString(),
  });
}

async function getValidToken() {
  const t = loadToken();
  if (!t || !t.access_token) throw new Error('Google is not connected — press Connect Agent in Providers');
  if (t.expires_at && Date.now() < t.expires_at - TOKEN_SKEW_MS) return t.access_token;
  if (!t.refresh_token) throw new Error('Google session expired — reconnect the agent to grant offline access');
  try {
    const next = await refreshToken();
    return next.access_token;
  } catch (e) {
    throw new Error(`Google session expired — reconnect the agent (${e.message})`);
  }
}

function status() {
  const t = loadToken();
  return {
    hasCredentials: hasCredentials(config.loadConfig()),
    hasToken: !!t,
    accountName: (t && (t.email || t.name)) || null,
    email: (t && t.email) || null,
    scopes: (t && t.scope) ? String(t.scope).split(/[ ,]+/).filter(Boolean) : SCOPES,
    obtainedAt: (t && (t.refreshed_at || t.obtained_at)) || null,
    expiresAt: (t && t.expires_at) || null,
  };
}

module.exports = {
  AUTH_URL, TOKEN_URL, SCOPES,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials, redirectUri, buildAuthUrl, exchangeCode,
  completeAuthorization, refreshToken, getValidToken, status,
  createState, verifyState,
};
