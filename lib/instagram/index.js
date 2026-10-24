'use strict';

// Instagram Business/Creator OAuth + token lifecycle. Instagram publishing uses the linked
// Facebook Page's access token and the Instagram business account id.

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
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
];

function tokenPath() {
  return path.join(config.studioDir(), 'config', 'instagram_token.json');
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
  return !!(c.instagram && c.instagram.clientId && c.instagram.clientSecret);
}

function redirectUri({ port } = {}) {
  const c = config.loadConfig();
  if (c.instagram && c.instagram.redirectUri) return c.instagram.redirectUri;
  const p = Number(port) || Number(process.env.PORT) || 4312;
  return process.env.INSTAGRAM_REDIRECT_URI || `http://localhost:${p}/auth/instagram/callback`;
}

function buildAuthUrl({ clientId, redirectUri: rd, scopes = SCOPES, state } = {}) {
  const c = config.loadConfig();
  const id = clientId || (c.instagram && c.instagram.clientId);
  if (!id) throw new Error('Instagram Client ID is not configured — add it in Providers → Instagram Agent Credentials');
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
  const c = config.loadConfig().instagram || {};
  if (!c.clientId || !c.clientSecret) throw new Error('Instagram credentials are not configured — add them in Providers');
  return c;
}

async function exchangeCode(code, { redirectUri: rd } = {}) {
  const c = credentials();
  const data = await tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: rd || redirectUri(),
    code,
  }, 'instagram OAuth');
  if (!data.access_token) throw new Error('Instagram token exchange returned no access token');
  return data;
}

async function exchangeLongLived(shortToken) {
  const c = credentials();
  const data = await tokenRequest({
    grant_type: 'fb_exchange_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    fb_exchange_token: shortToken,
  }, 'instagram long-lived token');
  if (!data.access_token) throw new Error('Instagram long-lived token exchange returned no access token');
  return data;
}

async function fetchInstagramAccount(userToken) {
  const u = new URL(`${GRAPH}/me/accounts`);
  u.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
  const res = await fetchOk(u, {
    headers: { authorization: `Bearer ${userToken}`, accept: 'application/json' },
  }, { source: 'instagram accounts', where: 'graph.facebook.com' });
  const data = await res.json();
  for (const page of (Array.isArray(data.data) ? data.data : [])) {
    const ig = page && page.instagram_business_account;
    if (ig && ig.id && page.access_token) {
      return { pageId: page.id, pageName: page.name || '', pageToken: page.access_token, igUserId: ig.id, username: ig.username || '' };
    }
  }
  throw new Error('no Instagram Business or Creator account is linked to a connected Facebook Page');
}

async function completeAuthorization(code, { redirectUri: rd } = {}) {
  const short = await exchangeCode(code, { redirectUri: rd });
  const long = await exchangeLongLived(short.access_token);
  const account = await fetchInstagramAccount(long.access_token);
  return saveToken({
    access_token: account.pageToken,
    user_access_token: long.access_token,
    token_type: long.token_type || short.token_type || 'bearer',
    scope: long.scope || short.scope || SCOPES.join(','),
    expires_at: Date.now() + (Number(long.expires_in) || Number(short.expires_in) || LONG_LIVED_FALLBACK_MS / 1000) * 1000,
    obtained_at: new Date().toISOString(),
    igUserId: account.igUserId,
    username: account.username,
    pageId: account.pageId,
    pageName: account.pageName,
  });
}

async function refreshToken() {
  const t = loadToken();
  if (!t || !t.user_access_token) throw new Error('Instagram is not connected — press Connect Agent in Providers');
  const refreshed = await exchangeLongLived(t.user_access_token);
  const account = await fetchInstagramAccount(refreshed.access_token);
  return saveToken({
    ...t,
    access_token: account.pageToken,
    user_access_token: refreshed.access_token,
    token_type: refreshed.token_type || t.token_type,
    scope: refreshed.scope || t.scope,
    expires_at: Date.now() + (Number(refreshed.expires_in) || LONG_LIVED_FALLBACK_MS / 1000) * 1000,
    refreshed_at: new Date().toISOString(),
    igUserId: account.igUserId,
    username: account.username,
    pageId: account.pageId,
    pageName: account.pageName,
  });
}

async function getValidToken() {
  const t = loadToken();
  if (!t || !t.access_token) throw new Error('Instagram is not connected — press Connect Agent in Providers');
  if (t.expires_at && Date.now() < t.expires_at - TOKEN_SKEW_MS) return t.access_token;
  try {
    const next = await refreshToken();
    return next.access_token;
  } catch (e) {
    throw new Error(`Instagram session expired — reconnect the agent (${e.message})`);
  }
}

function status() {
  const t = loadToken();
  return {
    hasCredentials: hasCredentials(config.loadConfig()),
    hasToken: !!t,
    accountName: (t && (t.username || t.pageName)) || null,
    igUserId: (t && t.igUserId) || null,
    username: (t && t.username) || null,
    pageId: (t && t.pageId) || null,
    pageName: (t && t.pageName) || null,
    scopes: (t && t.scope) ? String(t.scope).split(/[ ,]+/).filter(Boolean) : SCOPES,
    obtainedAt: (t && (t.refreshed_at || t.obtained_at)) || null,
    expiresAt: (t && t.expires_at) || null,
  };
}

module.exports = {
  VERSION, GRAPH, AUTH_URL, TOKEN_URL, SCOPES,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials, redirectUri, buildAuthUrl, exchangeCode, exchangeLongLived,
  fetchInstagramAccount, completeAuthorization, refreshToken, getValidToken, status,
  createState, verifyState,
};
