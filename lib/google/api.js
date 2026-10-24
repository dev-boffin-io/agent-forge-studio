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

module.exports = { hasAuth, hasCreds, getUserInfo, listAccounts, listLocations };
