'use strict';

// YouTube OAuth2 (installed-app flow) with full studio scopes. Zero dependencies:
// the auth URL + token exchange are plain HTTPS calls. Tokens live in the studio data dir
// (~/.ytstudio/<channel>/config/youtube_token.json), never in the channel workspace.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, studioDir } = require('../config');

// Full "YouTube Studio Agent" scopes — upload, edit, publish, manage, read analytics.
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtubepartner',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SKEW_MS = 60000; // refresh a minute early

// ---- OAuth CSRF protection -------------------------------------------------------------------
// The `state` parameter is a signed, single-use nonce. The nonce is random; the signature is an
// HMAC over it with a per-process secret, so a state is only accepted from a request that came
// back to a flow this process actually started. It is delivered to the browser in an HttpOnly
// SameSite=Lax cookie (see server.js) and compared timing-safely on the callback. The secret is
// regenerated on every boot, so restarting the server invalidates any in-flight consent flow.
const STATE_NONCE_BYTES = 32;
const STATE_TTL_MS = 10 * 60 * 1000; // a consent screen is not open longer than this
const STATE_SECRET = crypto.randomBytes(32);

function signState(nonce) {
  return crypto.createHmac('sha256', STATE_SECRET).update(nonce).digest('base64url');
}

/** Mint a fresh signed state: "<issuedAt>.<nonce>.<sig>". */
function createState() {
  const nonce = crypto.randomBytes(STATE_NONCE_BYTES).toString('base64url');
  const issued = String(Date.now());
  const payload = `${issued}.${nonce}`;
  return `${payload}.${signState(payload)}`;
}

/**
 * Verify a state returned by Google. Returns true only when the signature is valid (timing-safe)
 * and the state is within its TTL. Any malformed/missing/mismatched value returns false — never throws.
 */
function verifyState(state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [issued, nonce, sig] = parts;
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || !nonce || !sig) return false;
  if (Math.abs(now - issuedAt) > STATE_TTL_MS) return false;
  const expected = signState(`${issued}.${nonce}`);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenPath() {
  return path.join(studioDir(), 'config', 'youtube_token.json');
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
  return !!(c.youtube && c.youtube.clientId && c.youtube.clientSecret);
}

function redirectUri(reqOrCfg) {
  const c = loadConfig();
  if (c.youtube && c.youtube.redirectUri) return c.youtube.redirectUri;
  if (reqOrCfg && reqOrCfg.headers && reqOrCfg.headers.host) return `http://${reqOrCfg.headers.host}/auth/youtube/callback`;
  return process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:4312/auth/youtube/callback';
}

/** Build the Google consent URL the "Connect Agent" button opens. Always carries a signed `state`. */
function buildAuthUrl({ clientId, redirectUri: rd, scopes = SCOPES, state } = {}) {
  const c = loadConfig();
  const id = clientId || (c.youtube && c.youtube.clientId);
  if (!id) throw new Error('YouTube Client ID is not configured — add it in Providers → YouTube Agent Credentials');
  const st = state || createState();
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', rd || redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', st);
  return u.toString();
}

/** Exchange the OAuth callback code for access + refresh tokens (and persist them). */
async function exchangeCode(code, { redirectUri: rd } = {}) {
  const c = loadConfig();
  const clientId = c.youtube && c.youtube.clientId;
  const clientSecret = c.youtube && c.youtube.clientSecret;
  if (!clientId || !clientSecret) throw new Error('YouTube credentials are not configured');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: rd || redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`);
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    obtained_at: new Date().toISOString(),
  };
  saveToken(token);
  return token;
}

/** A valid access token, refreshing behind the scenes when expired. Throws when not connected. */
async function getAccessToken() {
  const t = loadToken();
  if (!t || !t.access_token) throw new Error('YouTube agent is not connected — press "Connect Agent" in the Providers dialog first');
  if (t.expires_at && Date.now() < t.expires_at - TOKEN_SKEW_MS) return t.access_token;
  if (!t.refresh_token) return t.access_token; // may still work; the API call will surface a real 401 if not
  const c = loadConfig();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: (c.youtube && c.youtube.clientId) || '',
      client_secret: (c.youtube && c.youtube.clientSecret) || '',
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token refresh failed (${res.status}): ${data.error_description || data.error || 'reconnect the agent'}`);
  const next = {
    ...t,
    access_token: data.access_token || t.access_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refreshed_at: new Date().toISOString(),
  };
  saveToken(next);
  return next.access_token;
}

module.exports = {
  SCOPES, AUTH_URL, TOKEN_URL,
  tokenPath, loadToken, saveToken, clearToken,
  hasCredentials, redirectUri, buildAuthUrl, exchangeCode, getAccessToken,
  createState, verifyState,
};
