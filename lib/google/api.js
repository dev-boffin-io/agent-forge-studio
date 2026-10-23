'use strict';

const { fetchOk, explain } = require('../errors');
const g = require('./index');

const API = 'https://www.googleapis.com';

function hasAuth(cfg) { return !!g.loadToken(); }
function hasCreds(cfg) { return g.hasCredentials(cfg); }

async function getUserInfo() {
  const token = g.loadToken();
  if (!token || !token.access_token) throw new Error('Google not authenticated — connect in Settings');
  const res = await fetchOk(`${API}/oauth2/v2/userinfo`, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } }, { source: 'google', where: 'www.googleapis.com' });
  return res.json();
}

module.exports = { hasAuth, hasCreds, getUserInfo };
