'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, studioDir } = require('../config');
const ig = require('./index');
const { fetchOk, explain } = require('../errors');

const GRAPH = 'https://graph.facebook.com/v19.0';

function hasAuth(cfg) { return !!ig.loadToken(); }
function hasCreds(cfg) { return ig.hasCredentials(cfg); }

async function getMe() {
  const token = ig.loadToken();
  if (!token || !token.access_token) throw new Error('Instagram not authenticated — connect in Settings');
  const res = await fetchOk(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(token.access_token)}`, { headers: { accept: 'application/json' } }, { source: 'instagram', where: 'graph.facebook.com' });
  return res.json();
}

async function publishPhoto({ imageUrl, caption = '' }) {
  const token = ig.loadToken();
  if (!token || !token.access_token) throw new Error('Instagram not authenticated — connect in Settings');
  if (!imageUrl) throw new Error('imageUrl is required');
  const res = await fetchOk(`${GRAPH}/me/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `image_url=${encodeURIComponent(imageUrl)}&caption=${encodeURIComponent(caption)}&access_token=${encodeURIComponent(token.access_token)}`,
  }, { source: 'instagram', where: 'graph.facebook.com' });
  const data = await res.json();
  if (!data.id) throw new Error(explain(data, 'instagram'));
  const pub = await fetchOk(`${GRAPH}/me/media_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `creation_id=${encodeURIComponent(data.id)}&access_token=${encodeURIComponent(token.access_token)}`,
  }, { source: 'instagram', where: 'graph.facebook.com' });
  return pub.json();
}

async function publishVideo({ videoUrl, caption = '' }) {
  const token = ig.loadToken();
  if (!token || !token.access_token) throw new Error('Instagram not authenticated — connect in Settings');
  if (!videoUrl) throw new Error('videoUrl is required');
  const res = await fetchOk(`${GRAPH}/me/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `media_type=REELS&video_url=${encodeURIComponent(videoUrl)}&caption=${encodeURIComponent(caption)}&access_token=${encodeURIComponent(token.access_token)}`,
  }, { source: 'instagram', where: 'graph.facebook.com' });
  const data = await res.json();
  if (!data.id) throw new Error(explain(data, 'instagram'));
  // Poll for status would be ideal; return creation_id for now
  return { creation_id: data.id, status: 'processing' };
}

module.exports = { hasAuth, hasCreds, getMe, publishPhoto, publishVideo };
