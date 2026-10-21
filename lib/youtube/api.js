'use strict';

// YouTube Data API v3 over plain fetch — zero dependencies. Used by the yt_* tools so the
// agent can upload, change visibility and read stats as a full Studio agent.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const oauth = require('./oauth');

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg',
};

function guessMime(p) {
  return MIME_BY_EXT[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';
}

/**
 * Build a multipart/related body (metadata JSON part + media part) for videos.insert.
 * Pure function so tests can verify the boundary framing without a network call.
 */
function buildMultipart(metadata, mediaPath, mimeType) {
  const boundary = 'yfs_' + crypto.randomBytes(12).toString('hex');
  const meta = Buffer.from(JSON.stringify(metadata), 'utf8');
  const media = fs.readFileSync(mediaPath);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'content-type: application/json; charset=UTF-8\r\n\r\n',
    'utf8',
  );
  const mid = Buffer.from(
    `\r\n--${boundary}\r\ncontent-type: ${mimeType || guessMime(mediaPath)}\r\ncontent-transfer-encoding: binary\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, meta, mid, media, tail]), boundary };
}

async function apiRequest(method, url, { json, accessToken } = {}) {
  const token = accessToken || (await oauth.getAccessToken());
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = (data.error && (data.error.errors || [{}])[0].reason) || data.error?.message || `HTTP ${res.status}`;
    throw new Error(`YouTube API ${method} ${new URL(url).pathname} failed: ${reason}`);
  }
  return data;
}

/** Upload a video file (private by default). Returns {id, url, privacyStatus}. */
async function uploadVideo({ filePath, title, description = '', tags = [], categoryId, privacyStatus = 'private', language }) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error(`not a file: ${filePath}`), { code: 'ENOENT' });
  const metadata = {
    snippet: {
      title: String(title || 'Untitled').slice(0, 100),
      description: String(description || '').slice(0, 5000),
      tags: Array.isArray(tags) ? tags.slice(0, 500).map(String) : [],
      ...(categoryId ? { categoryId: String(categoryId) } : {}),
      ...(language ? { defaultLanguage: language } : {}),
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };
  const { body, boundary } = buildMultipart(metadata, abs, guessMime(abs));
  const token = await oauth.getAccessToken();
  const res = await fetch(`${UPLOAD}?uploadType=multipart&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = (data.error && (data.error.errors || [{}])[0].reason) || data.error?.message || `HTTP ${res.status}`;
    throw new Error(`YouTube upload failed: ${reason}`);
  }
  return { id: data.id, url: `https://www.youtube.com/watch?v=${data.id}`, privacyStatus: data.status && data.status.privacyStatus };
}

/** Change visibility/privacy of a video: public | unlisted | private | privacyStatus unpublished. */
async function setVisibility(videoId, privacyStatus) {
  const data = await apiRequest('PATCH', `${API}/videos?part=status`, {
    json: { id: videoId, status: { privacyStatus } },
  });
  return { id: data.id, privacyStatus: data.status && data.status.privacyStatus };
}

/** Fetch one video's snippet + statistics. */
async function getVideo(videoId) {
  const data = await apiRequest('GET', `${API}/videos?part=snippet,status,statistics&id=${encodeURIComponent(videoId)}`);
  const v = (data.items || [])[0];
  if (!v) throw Object.assign(new Error(`video not found: ${videoId}`), { code: 'ENOENT' });
  return {
    id: v.id,
    title: v.snippet && v.snippet.title,
    description: v.snippet && v.snippet.description,
    publishedAt: v.snippet && v.snippet.publishedAt,
    privacyStatus: v.status && v.status.privacyStatus,
    statistics: v.statistics || {},
  };
}

/** List the channel's newest uploads (needs a connected channel; uses "mine" uploads playlist). */
async function listVideos({ maxResults = 10 } = {}) {
  const ch = await apiRequest('GET', `${API}/channels?part=contentDetails&mine=true`);
  const uploads = ch.items && ch.items[0] && ch.items[0].contentDetails && ch.items[0].contentDetails.relatedPlaylists && ch.items[0].contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error('no channel found for the connected account');
  const pl = await apiRequest('GET', `${API}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=${Math.min(50, Math.max(1, maxResults))}`);
  return (pl.items || []).map((it) => ({
    videoId: it.contentDetails && it.contentDetails.videoId,
    title: it.snippet && it.snippet.title,
    publishedAt: it.snippet && it.snippet.publishedAt,
    position: it.snippet && it.snippet.position,
  }));
}

module.exports = { API, UPLOAD, guessMime, buildMultipart, apiRequest, uploadVideo, setVisibility, getVideo, listVideos };
