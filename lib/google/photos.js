'use strict';

// Google Photos Library API: upload app-created media, list/get/download it, and manage albums.
// After April 2025 this API only exposes content created by this app. Use photos-picker.js to let
// the user select existing items from their full Google Photos library.

const fs = require('node:fs');
const path = require('node:path');
const { authHeader, requestJson, requestBuffer } = require('./api');

const PHOTOS = 'https://photoslibrary.googleapis.com/v1';
const UPLOADS = `${PHOTOS}/uploads`;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function clampPageSize(n, def = 25, max = 100) {
  return Math.max(1, Math.min(Number(n) || def, max));
}

function isVideo(item) {
  return String((item && item.mimeType) || '').toLowerCase().startsWith('video/')
    || !!(item && item.mediaMetadata && item.mediaMetadata.video);
}

function mediaDownloadUrl(baseUrl, { type, mimeType } = {}) {
  const base = String(baseUrl || '').trim();
  if (!base) throw new Error('media item has no baseUrl (a video may still be processing)');
  if (/=d[v]?$/.test(base)) return base;
  const video = String(type || '').toUpperCase() === 'VIDEO' || /^video\//i.test(String(mimeType || ''));
  return `${base}=${video ? 'dv' : 'd'}`;
}

function summarize(item) {
  if (!item) return null;
  const meta = item.mediaMetadata || {};
  return {
    id: item.id,
    filename: item.filename || '',
    description: item.description || '',
    mimeType: item.mimeType || '',
    productUrl: item.productUrl || '',
    baseUrl: item.baseUrl || '',
    creationTime: meta.creationTime || null,
    width: meta.width || null,
    height: meta.height || null,
    videoStatus: (meta.video && meta.video.status) || null,
  };
}

async function uploadBytes({ bytes, mimeType = 'application/octet-stream' } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('bytes are required');
  const headers = await authHeader();
  const data = await requestJson(UPLOADS, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-goog-upload-content-type': String(mimeType || 'application/octet-stream'),
      'x-goog-upload-protocol': 'raw',
    },
    body: bytes,
  }, 'photos upload');
  const token = typeof data === 'string' ? data.trim() : '';
  if (!token) throw new Error('Google Photos upload returned no upload token');
  return token;
}

async function createMediaItem({ uploadToken, fileName, description, albumId } = {}) {
  if (!uploadToken) throw new Error('uploadToken is required');
  const headers = await authHeader();
  const item = { simpleMediaItem: { uploadToken: String(uploadToken) } };
  if (fileName) item.simpleMediaItem.fileName = String(fileName);
  if (description) item.description = String(description).slice(0, 999);
  const body = { newMediaItems: [item] };
  if (albumId) body.albumId = String(albumId);
  const data = await requestJson(`${PHOTOS}/mediaItems:batchCreate`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  }, 'photos create media item');
  const result = data && Array.isArray(data.newMediaItemResults) ? data.newMediaItemResults[0] : null;
  const code = result && result.status && result.status.code;
  if (!result || (code != null && Number(code) !== 0)) {
    const message = (result && result.status && (result.status.message || `code ${code}`)) || 'no result';
    throw new Error(`Google Photos media item creation failed: ${message}`);
  }
  return {
    uploadToken: result.uploadToken || String(uploadToken),
    status: result.status || null,
    mediaItem: result.mediaItem || null,
    item: summarize(result.mediaItem),
  };
}

async function uploadMediaItem({ filePath, fileName, mimeType, description, albumId } = {}) {
  if (!filePath) throw new Error('filePath is required');
  const abs = path.resolve(String(filePath));
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`file is too large for a single upload (${stat.size} bytes; limit ${MAX_UPLOAD_BYTES})`);
  }
  const bytes = fs.readFileSync(abs);
  const type = mimeType || require('../youtube/api').guessMime(abs);
  const uploadToken = await uploadBytes({ bytes, mimeType: type });
  return createMediaItem({
    uploadToken,
    fileName: fileName || path.basename(abs),
    description,
    albumId,
  });
}

async function searchMediaItems({ albumId, filters, pageSize = 25, pageToken, orderBy } = {}) {
  const headers = await authHeader();
  const body = { pageSize: clampPageSize(pageSize) };
  if (albumId) body.albumId = String(albumId);
  if (filters) body.filters = filters;
  if (pageToken) body.pageToken = String(pageToken);
  if (orderBy) body.orderBy = String(orderBy);
  const data = await requestJson(`${PHOTOS}/mediaItems:search`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  }, 'photos search');
  return {
    mediaItems: (data && data.mediaItems) || [],
    nextPageToken: (data && data.nextPageToken) || null,
  };
}

async function listMediaItems({ pageSize = 25, pageToken, albumId } = {}) {
  if (albumId) return searchMediaItems({ albumId, pageSize, pageToken });
  const headers = await authHeader();
  const u = new URL(`${PHOTOS}/mediaItems`);
  u.searchParams.set('pageSize', String(clampPageSize(pageSize)));
  if (pageToken) u.searchParams.set('pageToken', String(pageToken));
  const data = await requestJson(u, { headers }, 'photos list');
  return {
    mediaItems: (data && data.mediaItems) || [],
    nextPageToken: (data && data.nextPageToken) || null,
  };
}

async function getMediaItem({ mediaItemId, id } = {}) {
  const mid = mediaItemId || id;
  if (!mid) throw new Error('mediaItemId is required');
  const headers = await authHeader();
  return requestJson(`${PHOTOS}/mediaItems/${encodeURIComponent(String(mid))}`, { headers }, 'photos get');
}

async function batchGetMediaItems({ mediaItemIds } = {}) {
  const ids = (Array.isArray(mediaItemIds) ? mediaItemIds : []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('mediaItemIds is required');
  const headers = await authHeader();
  const u = new URL(`${PHOTOS}/mediaItems:batchGet`);
  for (const id of ids.slice(0, 50)) u.searchParams.append('mediaItemIds', id);
  const data = await requestJson(u, { headers }, 'photos batch get');
  return { mediaItemResults: (data && data.mediaItemResults) || [] };
}

async function listAlbums({ pageSize = 25, pageToken, excludeNonAppCreatedData = true } = {}) {
  const headers = await authHeader();
  const u = new URL(`${PHOTOS}/albums`);
  u.searchParams.set('pageSize', String(clampPageSize(pageSize)));
  if (pageToken) u.searchParams.set('pageToken', String(pageToken));
  if (excludeNonAppCreatedData) u.searchParams.set('excludeNonAppCreatedData', 'true');
  const data = await requestJson(u, { headers }, 'photos list albums');
  return {
    albums: (data && data.albums) || [],
    nextPageToken: (data && data.nextPageToken) || null,
  };
}

async function getAlbum({ albumId } = {}) {
  if (!albumId) throw new Error('albumId is required');
  const headers = await authHeader();
  return requestJson(`${PHOTOS}/albums/${encodeURIComponent(String(albumId))}`, { headers }, 'photos get album');
}

async function createAlbum({ title } = {}) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  const headers = await authHeader();
  const album = await requestJson(`${PHOTOS}/albums`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { album: { title: String(title).trim() } },
  }, 'photos create album');
  return { ok: true, album };
}

async function addMediaItemsToAlbum({ albumId, mediaItemIds } = {}) {
  if (!albumId) throw new Error('albumId is required');
  const ids = (Array.isArray(mediaItemIds) ? mediaItemIds : []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('mediaItemIds is required');
  const headers = await authHeader();
  const data = await requestJson(`${PHOTOS}/albums/${encodeURIComponent(String(albumId))}:batchAddMediaItems`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { mediaItemIds: ids.slice(0, 50) },
  }, 'photos add to album');
  return { ok: true, albumId, mediaItemIds: ids.slice(0, 50), result: data };
}

async function removeMediaItemsFromAlbum({ albumId, mediaItemIds } = {}) {
  if (!albumId) throw new Error('albumId is required');
  const ids = (Array.isArray(mediaItemIds) ? mediaItemIds : []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('mediaItemIds is required');
  const headers = await authHeader();
  const data = await requestJson(`${PHOTOS}/albums/${encodeURIComponent(String(albumId))}:batchRemoveMediaItems`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { mediaItemIds: ids.slice(0, 50) },
  }, 'photos remove from album');
  return { ok: true, albumId, mediaItemIds: ids.slice(0, 50), result: data };
}

async function updateMediaItemDescription({ mediaItemId, description } = {}) {
  if (!mediaItemId) throw new Error('mediaItemId is required');
  const headers = await authHeader();
  const u = new URL(`${PHOTOS}/mediaItems/${encodeURIComponent(String(mediaItemId))}`);
  u.searchParams.set('updateMask', 'description');
  return requestJson(u, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { id: String(mediaItemId), description: String(description == null ? '' : description).slice(0, 999) },
  }, 'photos update description');
}

async function downloadMediaItem({ mediaItemId } = {}) {
  const item = await getMediaItem({ mediaItemId });
  const status = item.mediaMetadata && item.mediaMetadata.video && item.mediaMetadata.video.status;
  if (isVideo(item) && status && status !== 'READY') {
    throw new Error(`video is ${status}; wait until Google finishes processing it (status READY) before downloading`);
  }
  const url = mediaDownloadUrl(item.baseUrl, { mimeType: item.mimeType, type: isVideo(item) ? 'VIDEO' : 'PHOTO' });
  const headers = { ...(await authHeader()), accept: '*/*' };
  const out = await requestBuffer(url, { headers }, 'photos download');
  return { ...out, mediaItem: item, url };
}

module.exports = {
  PHOTOS, UPLOADS, MAX_UPLOAD_BYTES,
  isVideo, mediaDownloadUrl, summarize,
  uploadBytes, createMediaItem, uploadMediaItem,
  searchMediaItems, listMediaItems, getMediaItem, batchGetMediaItems,
  listAlbums, getAlbum, createAlbum, addMediaItemsToAlbum, removeMediaItemsFromAlbum,
  updateMediaItemDescription, downloadMediaItem,
};
