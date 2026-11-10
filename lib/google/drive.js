'use strict';

// Google Drive: search/list, metadata, download/export, upload and folder creation.

const crypto = require('node:crypto');
const { authHeader, requestJson, requestBuffer } = require('./api');

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,size,webViewLink,webContentLink,parents,owners(displayName,emailAddress),iconLink';

function fileQuery({ query, includeTrashed = false } = {}) {
  const parts = [];
  if (!includeTrashed) parts.push('trashed = false');
  if (query && String(query).trim()) parts.push(`(${String(query).trim()})`);
  return parts.join(' and ');
}

async function listFiles({ query, pageSize = 25, pageToken, orderBy = 'modifiedTime desc', includeTrashed = false } = {}) {
  const headers = await authHeader();
  const u = new URL(`${DRIVE}/files`);
  const q = fileQuery({ query, includeTrashed });
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('pageSize', String(Math.max(1, Math.min(Number(pageSize) || 25, 1000))));
  u.searchParams.set('orderBy', String(orderBy || 'modifiedTime desc'));
  u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
  if (pageToken) u.searchParams.set('pageToken', String(pageToken));
  const data = await requestJson(u, { headers }, 'drive list');
  return { files: (data && data.files) || [], nextPageToken: (data && data.nextPageToken) || null };
}

async function getFile({ fileId, fields = FILE_FIELDS } = {}) {
  if (!fileId) throw new Error('fileId is required');
  const headers = await authHeader();
  const u = new URL(`${DRIVE}/files/${encodeURIComponent(String(fileId))}`);
  u.searchParams.set('fields', String(fields || FILE_FIELDS));
  return requestJson(u, { headers }, 'drive file');
}

async function downloadFile({ fileId } = {}) {
  if (!fileId) throw new Error('fileId is required');
  const headers = await authHeader();
  const u = new URL(`${DRIVE}/files/${encodeURIComponent(String(fileId))}`);
  u.searchParams.set('alt', 'media');
  return requestBuffer(u, { headers }, 'drive download');
}

async function exportFile({ fileId, mimeType } = {}) {
  if (!fileId) throw new Error('fileId is required');
  if (!mimeType) throw new Error('mimeType is required (e.g. text/plain, application/pdf)');
  const headers = await authHeader();
  const u = new URL(`${DRIVE}/files/${encodeURIComponent(String(fileId))}/export`);
  u.searchParams.set('mimeType', String(mimeType));
  return requestBuffer(u, { headers }, 'drive export');
}

async function createFolder({ name, parentId } = {}) {
  if (!name || !String(name).trim()) throw new Error('name is required');
  const headers = await authHeader();
  const body = { name: String(name), mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [String(parentId)];
  return requestJson(`${DRIVE}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  }, 'drive create folder');
}

async function uploadFile({ name, content, encoding = 'utf8', mimeType = 'application/octet-stream', parentId } = {}) {
  if (!name || !String(name).trim()) throw new Error('name is required');
  if (content === undefined || content === null) throw new Error('content is required');
  const headers = await authHeader();
  const buffer = Buffer.from(String(content), encoding === 'base64' ? 'base64' : 'utf8');
  const meta = { name: String(name), mimeType: String(mimeType) };
  if (parentId) meta.parents = [String(parentId)];
  const boundary = `----agentforge${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const u = `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
  return requestJson(u, {
    method: 'POST',
    headers: { ...headers, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  }, 'drive upload');
}

async function deleteFile({ fileId } = {}) {
  if (!fileId) throw new Error('fileId is required');
  const headers = await authHeader();
  await requestJson(`${DRIVE}/files/${encodeURIComponent(String(fileId))}`, { method: 'DELETE', headers }, 'drive delete');
  return { ok: true, fileId };
}

module.exports = {
  DRIVE, DRIVE_UPLOAD, FILE_FIELDS,
  listFiles, getFile, downloadFile, exportFile, createFolder, uploadFile, deleteFile,
};
