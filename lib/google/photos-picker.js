'use strict';

// Google Photos Picker API: lets the user select existing photos/videos from their full library.
// The flow is interactive: create a session, give the user the pickerUri, then poll/list/download.
// Requires the photospicker.mediaitems.readonly scope.

const { authHeader, requestJson, requestBuffer } = require('./api');
const { mediaDownloadUrl } = require('./photos');

const PICKER = 'https://photospicker.googleapis.com/v1';
const MAX_LIST = 100;

function parseDurationMs(value, fallback) {
  const m = /^([0-9.]+)s$/.exec(String(value || '').trim());
  return m ? Number(m[1]) * 1000 : fallback;
}

function summarize(item) {
  if (!item) return null;
  const file = item.mediaFile || {};
  const meta = file.mediaFileMetadata || {};
  return {
    id: item.id,
    type: item.type || '',
    createTime: item.createTime || null,
    filename: file.filename || '',
    mimeType: file.mimeType || '',
    baseUrl: file.baseUrl || '',
    width: meta.width || null,
    height: meta.height || null,
    videoStatus: (meta.videoMetadata && meta.videoMetadata.processingStatus) || null,
  };
}

async function createSession({ maxItemCount } = {}) {
  const headers = await authHeader();
  const body = {};
  const n = Number(maxItemCount);
  if (n > 0) body.pickingConfig = { maxItemCount: String(Math.min(Math.floor(n), 2000)) };
  return requestJson(`${PICKER}/sessions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  }, 'photos picker create');
}

async function getSession({ sessionId } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  const headers = await authHeader();
  return requestJson(`${PICKER}/sessions/${encodeURIComponent(String(sessionId))}`, { headers }, 'photos picker session');
}

async function deleteSession({ sessionId } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  const headers = await authHeader();
  await requestJson(`${PICKER}/sessions/${encodeURIComponent(String(sessionId))}`, { method: 'DELETE', headers }, 'photos picker delete');
  return { ok: true, sessionId };
}

async function listMediaItems({ sessionId, pageSize = 50, pageToken } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  const headers = await authHeader();
  const u = new URL(`${PICKER}/mediaItems`);
  u.searchParams.set('sessionId', String(sessionId));
  u.searchParams.set('pageSize', String(Math.max(1, Math.min(Number(pageSize) || 50, MAX_LIST))));
  if (pageToken) u.searchParams.set('pageToken', String(pageToken));
  const data = await requestJson(u, { headers }, 'photos picker list');
  return {
    mediaItems: (data && data.mediaItems) || [],
    nextPageToken: (data && data.nextPageToken) || null,
  };
}

async function listAllMediaItems({ sessionId, maxItems = 500 } = {}) {
  const limit = Math.max(1, Math.min(Number(maxItems) || 500, 2000));
  const mediaItems = [];
  let pageToken;
  do {
    const page = await listMediaItems({ sessionId, pageSize: MAX_LIST, pageToken });
    mediaItems.push(...page.mediaItems);
    pageToken = page.nextPageToken;
  } while (pageToken && mediaItems.length < limit);
  return { mediaItems: mediaItems.slice(0, limit), complete: !pageToken };
}

async function waitForSelection({ sessionId, timeoutMs = 120000, intervalMs } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 300000));
  let session = await getSession({ sessionId });
  const recommended = parseDurationMs(session.pollingConfig && session.pollingConfig.timeoutIn, timeout);
  const deadline = Date.now() + Math.min(timeout, recommended);
  while (!session.mediaItemsSet && Date.now() < deadline) {
    const interval = parseDurationMs(session.pollingConfig && session.pollingConfig.pollInterval, 3000);
    const wait = Math.max(250, Math.min(Number(intervalMs) || interval, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, wait));
    session = await getSession({ sessionId });
  }
  return { ...session, timedOut: !session.mediaItemsSet };
}

async function findMediaItem({ sessionId, mediaItemId } = {}) {
  if (!sessionId || !mediaItemId) throw new Error('sessionId and mediaItemId are required');
  let pageToken;
  do {
    const page = await listMediaItems({ sessionId, pageSize: MAX_LIST, pageToken });
    const found = page.mediaItems.find((item) => String(item.id) === String(mediaItemId));
    if (found) return found;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return null;
}

async function downloadMediaItem({ sessionId, mediaItemId, baseUrl, type, mimeType } = {}) {
  let item = null;
  let url = baseUrl;
  let kind = type;
  let fileType = mimeType;
  if (!url) {
    item = await findMediaItem({ sessionId, mediaItemId });
    if (!item) throw new Error(`media item ${mediaItemId} was not found in this picker session`);
    const file = item.mediaFile || {};
    url = file.baseUrl;
    kind = item.type;
    fileType = file.mimeType;
  }
  const target = mediaDownloadUrl(url, { type: kind, mimeType: fileType });
  const headers = { ...(await authHeader()), accept: '*/*' };
  const out = await requestBuffer(target, { headers }, 'photos picker download');
  return { ...out, mediaItem: item, url: target };
}

module.exports = {
  PICKER, parseDurationMs, summarize,
  createSession, getSession, deleteSession,
  listMediaItems, listAllMediaItems, waitForSelection,
  findMediaItem, downloadMediaItem,
};
