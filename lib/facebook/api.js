'use strict';

const { fetchOk, explain } = require('../errors');
const fb = require('./index');

const GRAPH = 'https://graph.facebook.com/v19.0';

function hasAuth(cfg) { return !!fb.loadToken(); }
function hasCreds(cfg) { return fb.hasCredentials(cfg); }

async function getPages() {
  const token = fb.loadToken();
  if (!token || !token.access_token) throw new Error('Facebook not authenticated — connect in Settings');
  const res = await fetchOk(`${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token.access_token)}`, { headers: { accept: 'application/json' } }, { source: 'facebook', where: 'graph.facebook.com' });
  return res.json();
}

async function publishToPage({ pageId, message = '', link = '', photoUrl = '' }) {
  const token = fb.loadToken();
  if (!token || !token.access_token) throw new Error('Facebook not authenticated — connect in Settings');
  if (!pageId) throw new Error('pageId is required');
  const pageToken = token.pages && token.pages[pageId] ? token.pages[pageId] : token.access_token;
  if (photoUrl) {
    const res = await fetchOk(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(photoUrl)}&caption=${encodeURIComponent(message)}&access_token=${encodeURIComponent(pageToken)}`,
    }, { source: 'facebook', where: 'graph.facebook.com' });
    return res.json();
  }
  const body = `message=${encodeURIComponent(message)}${link ? '&link=' + encodeURIComponent(link) : ''}&access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetchOk(`${GRAPH}/${encodeURIComponent(pageId)}/feed`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, { source: 'facebook', where: 'graph.facebook.com' });
  return res.json();
}

module.exports = { hasAuth, hasCreds, getPages, publishToPage };
