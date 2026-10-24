'use strict';

const { fetchOk } = require('../errors');
const fb = require('./index');

const GRAPH = fb.GRAPH;

async function graphRequest(route, { method = 'GET', params = {}, token } = {}) {
  const u = new URL(`${GRAPH}/${String(route).replace(/^\/+/, '')}`);
  const opts = {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  } else {
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  }
  const res = await fetchOk(u, opts, { source: 'facebook', where: 'graph.facebook.com' });
  return res.json();
}

function hasAuth() { return !!fb.loadToken(); }
function hasCreds(cfg) { return fb.hasCredentials(cfg); }

async function getPages() {
  const token = await fb.getValidToken();
  const data = await graphRequest('me/accounts', { params: { fields: 'id,name' }, token });
  return (Array.isArray(data.data) ? data.data : []).map((p) => ({ id: p.id, name: p.name }));
}

async function resolvePage(pageId) {
  const userToken = await fb.getValidToken();
  const t = fb.loadToken() || {};
  const known = Object.keys(t.pages || {});
  const id = String(pageId || (known.length === 1 ? known[0] : '')).trim();
  if (!id) {
    if (!known.length) throw new Error('no Facebook Page is connected — reconnect the agent and grant page access');
    throw new Error(`pageId is required when more than one Page is connected (${known.join(', ')})`);
  }
  const stored = t.pages && t.pages[id];
  const token = typeof stored === 'string' ? stored : (stored && stored.access_token) || userToken;
  return { pageId: id, token };
}

async function publishText({ pageId, message }) {
  if (!message || !String(message).trim()) throw new Error('message is required');
  const page = await resolvePage(pageId);
  return graphRequest(`${encodeURIComponent(page.pageId)}/feed`, {
    method: 'POST',
    token: page.token,
    params: { message: String(message) },
  });
}

async function publishLink({ pageId, message = '', link }) {
  if (!link || !/^https:\/\//i.test(String(link))) throw new Error('link must be an https URL');
  const page = await resolvePage(pageId);
  return graphRequest(`${encodeURIComponent(page.pageId)}/feed`, {
    method: 'POST',
    token: page.token,
    params: { message: String(message || ''), link: String(link) },
  });
}

async function publishPhoto({ pageId, message = '', photoUrl }) {
  if (!photoUrl || !/^https:\/\//i.test(String(photoUrl))) throw new Error('photoUrl must be an https URL');
  const page = await resolvePage(pageId);
  return graphRequest(`${encodeURIComponent(page.pageId)}/photos`, {
    method: 'POST',
    token: page.token,
    params: { caption: String(message || ''), url: String(photoUrl) },
  });
}

async function publishToPage({ pageId, message = '', link = '', photoUrl = '' }) {
  if (photoUrl) return publishPhoto({ pageId, message, photoUrl });
  if (link) return publishLink({ pageId, message, link });
  return publishText({ pageId, message });
}

module.exports = {
  hasAuth, hasCreds, getPages, resolvePage,
  publishText, publishLink, publishPhoto, publishToPage,
};
