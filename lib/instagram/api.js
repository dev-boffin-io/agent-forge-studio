'use strict';

const config = require('../config');
const { fetchOk } = require('../errors');
const ig = require('./index');

const GRAPH = ig.GRAPH;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_INTERVAL_MS = 3000;

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
  const res = await fetchOk(u, opts, { source: 'instagram', where: 'graph.facebook.com' });
  return res.json();
}

function hasAuth() { return !!ig.loadToken(); }
function hasCreds(cfg) { return ig.hasCredentials(cfg); }

async function accountContext() {
  const token = await ig.getValidToken();
  const t = ig.loadToken() || {};
  if (!t.igUserId) throw new Error('Instagram business account is not connected — reconnect the agent');
  return { token, igUserId: t.igUserId, username: t.username || '' };
}

async function getMe() {
  const { token, igUserId, username } = await accountContext();
  const data = await graphRequest(igUserId, { params: { fields: 'id,username' }, token });
  return { id: data.id || igUserId, username: data.username || username };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForContainer(creationId, token, { timeoutMs, intervalMs } = {}) {
  const timeout = Number(timeoutMs) || Number(config.loadConfig().instagram && config.loadConfig().instagram.publishTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const interval = Math.max(1, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const data = await graphRequest(creationId, { params: { fields: 'status_code,status' }, token });
    last = data.status_code || data.status || '';
    if (last === 'FINISHED') return data;
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`Instagram media processing failed (${data.status || last})`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
  }
  throw new Error(`Instagram media did not finish processing within ${Math.round(timeout / 1000)}s${last ? ` (last status: ${last})` : ''}`);
}

async function createContainer({ imageUrl, videoUrl, caption = '', token }) {
  const params = { caption: String(caption || '') };
  if (videoUrl) {
    params.media_type = 'REELS';
    params.video_url = String(videoUrl);
  } else {
    params.image_url = String(imageUrl);
  }
  const { igUserId } = await accountContext();
  return graphRequest(`${igUserId}/media`, { method: 'POST', params, token });
}

async function publishPhoto({ imageUrl, caption = '', timeoutMs, intervalMs } = {}) {
  if (!imageUrl || !/^https:\/\//i.test(String(imageUrl))) throw new Error('imageUrl must be an https URL');
  if (String(caption || '').length > 2200) throw new Error('Instagram captions are limited to 2200 characters');
  const { token } = await accountContext();
  const container = await createContainer({ imageUrl, caption, token });
  if (!container.id) throw new Error('Instagram did not return a media container id');
  await waitForContainer(container.id, token, { timeoutMs, intervalMs });
  return graphRequest(`${(await accountContext()).igUserId}/media_publish`, {
    method: 'POST',
    params: { creation_id: container.id },
    token,
  });
}

async function publishReel({ videoUrl, caption = '', timeoutMs, intervalMs } = {}) {
  if (!videoUrl || !/^https:\/\//i.test(String(videoUrl))) throw new Error('videoUrl must be an https URL');
  if (String(caption || '').length > 2200) throw new Error('Instagram captions are limited to 2200 characters');
  const { token } = await accountContext();
  const container = await createContainer({ videoUrl, caption, token });
  if (!container.id) throw new Error('Instagram did not return a media container id');
  await waitForContainer(container.id, token, { timeoutMs, intervalMs });
  return graphRequest(`${(await accountContext()).igUserId}/media_publish`, {
    method: 'POST',
    params: { creation_id: container.id },
    token,
  });
}

async function publishVideo(args) { return publishReel(args); }

module.exports = {
  hasAuth, hasCreds, getMe, createContainer, waitForContainer,
  publishPhoto, publishReel, publishVideo,
};
