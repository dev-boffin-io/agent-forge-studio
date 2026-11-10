'use strict';

const { fetchOk } = require('../errors');
const g = require('./index');

const OAUTH2 = 'https://www.googleapis.com/oauth2/v2';
const MYBUSINESS = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const MYBUSINESS_ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com/v1';

function hasAuth() { return !!g.loadToken(); }
function hasCreds(cfg) { return g.hasCredentials(cfg); }

async function authHeader() {
  const token = await g.getValidToken();
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

/**
 * Authenticated JSON request to a Google API. Accepts a URL or URL string, JSON-serialises plain
 * object bodies, and returns null for empty/204 responses. Binary uploads pass a Buffer body.
 */
async function requestJson(url, { method = 'GET', headers, body } = {}, source = 'google') {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      opts.body = body;
    } else {
      opts.headers['content-type'] = opts.headers['content-type'] || 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const host = (() => { try { return new URL(String(url)).host; } catch { return 'www.googleapis.com'; } })();
  const res = await fetchOk(url, opts, { source, where: host });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function requestBuffer(url, { method = 'GET', headers } = {}, source = 'google') {
  const host = (() => { try { return new URL(String(url)).host; } catch { return 'www.googleapis.com'; } })();
  const res = await fetchOk(url, { method, headers: { ...(headers || {}) } }, { source, where: host });
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || null };
}

async function getUserInfo() {
  const headers = await authHeader();
  const res = await fetchOk(`${OAUTH2}/userinfo`, { headers }, { source: 'google userinfo', where: 'www.googleapis.com' });
  return res.json();
}

async function listAccounts() {
  const headers = await authHeader();
  const res = await fetchOk(`${MYBUSINESS_ACCOUNTS}/accounts`, { headers }, { source: 'google business', where: 'mybusinessaccountmanagement.googleapis.com' });
  const data = await res.json();
  return Array.isArray(data.accounts) ? data.accounts : (Array.isArray(data) ? data : []);
}

async function listLocations({ accountName } = {}) {
  const headers = await authHeader();
  if (accountName) {
    const name = String(accountName).startsWith('accounts/') ? String(accountName) : `accounts/${accountName}`;
    const res = await fetchOk(`${MYBUSINESS}/${name}/locations?readMask=name,title,storefrontAddress,phoneNumbers,websiteUri`, { headers }, { source: 'google business', where: 'mybusinessbusinessinformation.googleapis.com' });
    const data = await res.json();
    return Array.isArray(data.locations) ? data.locations : [];
  }
  const accounts = await listAccounts();
  const all = [];
  for (const acct of accounts) {
    const n = acct.name || acct.accountName;
    if (!n) continue;
    try {
      const locs = await listLocations({ accountName: n });
      for (const loc of locs) all.push({ account: acct, location: loc });
    } catch { /* keep going across accounts */ }
  }
  return all;
}

module.exports = {
  hasAuth, hasCreds, authHeader, requestJson, requestBuffer,
  getUserInfo, listAccounts, listLocations,
};
