'use strict';

// stock — stock-footage search with a provider cascade. Each provider is a small adapter that
// turns a topic into a list of downloadable video candidates; the cascade tries them in order and
// downloads the first ones that work. When no provider yields anything — the keyed providers have
// no key or fail, and the keyless Wikimedia provider is unreachable or empty — we degrade to a
// clearly-marked stub shot list (file:null, stub:true) so the pipeline never breaks. Real clips
// come back with stub:false.
//
// Providers (in cascade order):
//   pexels    — https://www.pexels.com/api/            (cfg.pexelsApiKey  / env PEXELS_API_KEY)
//   pixabay   — https://pixabay.com/api/docs/          (cfg.pixabayApiKey / env PIXABAY_API_KEY)
//   wikimedia — https://commons.wikimedia.org/w/api.php (keyless; CC / public-domain media)
//
// The Wikimedia provider needs no key, so a user with no API keys at all can still pull real,
// freely-licensed clips straight from the web.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { fetchOk } = require('./errors');

const PEXELS_SEARCH = 'https://api.pexels.com/videos/search';
const PIXABAY_SEARCH = 'https://pixabay.com/api/videos/';
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia's API policy requires an identifying User-Agent.
const WIKIMEDIA_UA = 'YouTubeForgeStudio/1.0 (https://github.com/youtube-forge-studio)';

/** Absolute workspace path for a relative artifact, falling back to cwd. */
function absUnder(workDir, relPath) {
  const base = workDir || process.cwd();
  return path.isAbsolute(relPath) ? relPath : path.join(base, relPath);
}

/** Slugify a topic into a safe folder name. */
function slugify(text) {
  return String(text || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
}

/** From a list of {width,...} candidates pick the best fit for a 1080p timeline. */
function rankByWidth(candidates, targetW = 1920) {
  return candidates.slice().sort((a, b) => {
    const score = (f) => (Number(f.width) >= 1280 ? 0 : 1000) + Math.abs((Number(f.width) || 0) - targetW);
    return score(a) - score(b);
  })[0];
}

// ---- Pexels adapter -------------------------------------------------------------------------

/** Best MP4 rendition for a Pexels video object. Exported for tests. */
function pickPexelsFile(video) {
  const files = Array.isArray(video && video.video_files) ? video.video_files : [];
  const mp4 = files.filter((f) => (f.file_type || '').includes('mp4') || /\.mp4($|\?)/i.test(f.link || ''));
  const pool = mp4.length ? mp4 : files;
  if (!pool.length) return null;
  return rankByWidth(pool, 1920);
}

/**
 * Parse a Pexels /videos/search body into downloadable candidates.
 * Exported for tests. Each candidate: {url, width, duration}.
 */
function parsePexels(body) {
  const videos = Array.isArray(body && body.videos) ? body.videos : [];
  const out = [];
  for (const v of videos) {
    const file = pickPexelsFile(v);
    if (!file || !file.link) continue;
    out.push({ url: file.link, width: Number(file.width) || 0, duration: Number(v.duration) || 0 });
  }
  return out;
}

async function searchPexels({ topic, key, want, orientation, signal }) {
  const url = new URL(PEXELS_SEARCH);
  url.searchParams.set('query', String(topic || 'cinematic b-roll'));
  url.searchParams.set('per_page', String(want));
  url.searchParams.set('orientation', orientation);
  const res = await fetchOk(url.toString(), { headers: { Authorization: key }, signal }, { source: 'pexels', where: 'api.pexels.com' });
  return parsePexels(await res.json());
}

// ---- Pixabay adapter ------------------------------------------------------------------------

const PIXABAY_SIZES = ['large', 'medium', 'small', 'tiny'];

/**
 * Best MP4 rendition for a Pixabay hit. Pixabay nests renditions under `videos.{large,medium,...}`
 * with `{url,width,height,size,thumbnail}`; prefer the best available size.
 */
function pickPixabayFile(hit) {
  const videos = (hit && hit.videos) || {};
  const candidates = [];
  for (const size of PIXABAY_SIZES) {
    const v = videos[size];
    if (v && v.url) candidates.push({ width: Number(v.width) || 0, url: v.url });
  }
  if (!candidates.length) return null;
  return rankByWidth(candidates, 1920);
}

/**
 * Parse a Pixabay /api/videos/ body into downloadable candidates.
 * Exported for tests. Each candidate: {url, width, duration}.
 */
function parsePixabay(body) {
  const hits = Array.isArray(body && body.hits) ? body.hits : [];
  const out = [];
  for (const hit of hits) {
    const file = pickPixabayFile(hit);
    if (!file || !file.url) continue;
    out.push({ url: file.url, width: file.width, duration: Number(hit.duration) || 0 });
  }
  return out;
}

async function searchPixabay({ topic, key, want, orientation, signal }) {
  const url = new URL(PIXABAY_SEARCH);
  url.searchParams.set('key', key);
  url.searchParams.set('q', String(topic || 'cinematic b-roll').slice(0, 100));
  url.searchParams.set('per_page', String(Math.max(3, want)));   // Pixabay requires >= 3
  url.searchParams.set('safesearch', 'true');
  // Pixabay has no orientation param; request landscape-ish minimums instead.
  if (orientation === 'landscape') url.searchParams.set('min_width', '1280');
  const res = await fetchOk(url.toString(), { signal }, { source: 'pixabay', where: 'pixabay.com' });
  return parsePixabay(await res.json());
}

// ---- Wikimedia Commons adapter (keyless) ----------------------------------------------------

/** Video extensions Wikimedia serves. mp4 is preferred; webm/ogv are ffmpeg-decodable. */
const WIKIMEDIA_VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:$|\?)/i;

/** The file extension to save a Wikimedia clip as, derived from its URL. */
function wikimediaExt(url) {
  const m = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:$|\?)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : 'webm';
}

/**
 * Pick the best video candidate from one Commons page's imageinfo. Commons returns the original
 * upload (usually .webm/.ogv); we prefer an .mp4 when the response happens to expose one, then
 * fall back to any recognised video URL.
 */
function pickWikimediaFile(imageinfo) {
  const infos = Array.isArray(imageinfo) ? imageinfo : [];
  const videos = infos.filter((i) => i && i.url && (i.mime ? /^video\//i.test(i.mime) : WIKIMEDIA_VIDEO_EXT.test(i.url)));
  if (!videos.length) return null;
  const mp4 = videos.filter((i) => /\.mp4(?:$|\?)/i.test(i.url) || (i.mime || '').includes('mp4'));
  return rankByWidth(mp4.length ? mp4 : videos, 1920);
}

/**
 * Parse a Wikimedia Commons API body (action=query, generator=search, prop=imageinfo) into
 * downloadable candidates. Exported for tests. Each candidate: {url, width, duration, ext}.
 * `query.pages` is an object keyed by pageid; each page carries `imageinfo: [{url,mime,...}]`.
 */
function parseWikimedia(body) {
  const pages = (body && body.query && body.query.pages) || {};
  const list = Array.isArray(pages) ? pages : Object.values(pages);
  const out = [];
  for (const page of list) {
    const file = pickWikimediaFile(page && page.imageinfo);
    if (!file || !file.url) continue;
    out.push({
      url: file.url,
      width: Number(file.width) || 0,
      duration: Number(file.duration) || 0,
      ext: wikimediaExt(file.url),
    });
  }
  return out;
}

async function searchWikimedia({ topic, want, signal }) {
  const url = new URL(WIKIMEDIA_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrnamespace', '6');           // File: namespace
  url.searchParams.set('gsrsearch', `filetype:video ${String(topic || 'b-roll')}`);
  url.searchParams.set('gsrlimit', String(Math.max(1, Math.min(want, 10))));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|size');
  const res = await fetchOk(url.toString(), { headers: { 'User-Agent': WIKIMEDIA_UA }, signal }, { source: 'wikimedia', where: 'commons.wikimedia.org' });
  return parseWikimedia(await res.json());
}

// ---- cascade --------------------------------------------------------------------------------

/** A provider descriptor. `search` returns [{url,width,duration}]; `key` picks the credential. */
const PROVIDERS = [
  {
    id: 'pexels',
    keyOf: (cfg) => (cfg && (cfg.pexelsApiKey || cfg.PEXELS_API_KEY)) || process.env.PEXELS_API_KEY || '',
    search: searchPexels,
    label: 'Pexels',
  },
  {
    id: 'pixabay',
    keyOf: (cfg) => (cfg && (cfg.pixabayApiKey || cfg.PIXABAY_API_KEY)) || process.env.PIXABAY_API_KEY || '',
    search: searchPixabay,
    label: 'Pixabay',
  },
  {
    // Keyless: always available, so it runs whenever the keyed providers are absent or fail.
    id: 'wikimedia',
    keyOf: () => 'keyless',
    search: searchWikimedia,
    label: 'Wikimedia Commons',
  },
];

/**
 * Download a provider's candidates into `<workDir>/autoforge/<slug>/footage/` as a shot list.
 * Returns {shots, provider, count} or null when nothing could be downloaded.
 */
async function downloadClips({ candidates, topic, workDir, want, perShot, signal, providerId }) {
  const dirRel = path.join('autoforge', slugify(topic), 'footage');
  const dirAbs = absUnder(workDir, dirRel);
  fs.mkdirSync(dirAbs, { recursive: true });

  const shots = [];
  let cursor = 0;
  for (const c of candidates) {
    if (!c.url) continue;
    const ext = c.ext || 'mp4';
    const name = `${providerId}-${String(shots.length + 1).padStart(2, '0')}.${ext}`;
    const destAbs = path.join(dirAbs, name);
    try {
      const res = await fetchOk(c.url, { signal }, { source: providerId, where: new URL(c.url).host });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty download');
      fs.writeFileSync(destAbs, buf);
    } catch (e) {
      log.warn('stock', `could not download a ${providerId} clip (${name})`, e);
      continue;
    }
    const dur = Number(c.duration) > 0 ? Number(c.duration) : perShot;
    const len = Math.min(dur, perShot * 2);
    shots.push({
      file: path.relative(workDir || process.cwd(), destAbs),
      start: Number(cursor.toFixed(2)),
      end: Number((cursor + len).toFixed(2)),
      query: String(topic || ''),
      provider: providerId,
      stub: false,
    });
    cursor += len;
    if (shots.length >= want) break;
  }
  return shots.length ? { shots, provider: providerId, count: shots.length } : null;
}

/**
 * Search stock footage with the provider cascade and download real clips when possible.
 *
 * @param {object} opts
 * @param {string} opts.topic
 * @param {string} [opts.workDir]
 * @param {object} [opts.cfg]
 * @param {number} [opts.count]    how many clips to fetch (default 4)
 * @param {number} [opts.perShot]  seconds per shot when no duration is known (default 5)
 * @returns {{shots:Array, stub:boolean, provider?:string, count?:number, reason?:string, todo?:string}}
 */
async function findStockFootage({ topic = '', workDir, cfg = {}, count = 4, perShot = 5 } = {}) {
  const want = Math.max(1, Math.min(Number(count) || 4, 10));
  const orientation = (cfg.stockFootage && cfg.stockFootage.orientation) || 'landscape';
  const attempted = [];
  const notes = [];

  for (const provider of PROVIDERS) {
    const key = provider.keyOf(cfg);
    if (!key) {
      notes.push(`${provider.label}: no API key`);
      continue;
    }
    attempted.push(provider.id);
    let candidates = [];
    try {
      candidates = await provider.search({ topic, key, want, orientation, signal: cfg && cfg.signal });
    } catch (e) {
      log.warn('stock', `${provider.label} search failed — trying the next provider`, e);
      notes.push(`${provider.label}: search failed (${e.message})`);
      continue;
    }
    if (!candidates.length) {
      log.warn('stock', `${provider.label} returned no clips for "${topic}"`);
      notes.push(`${provider.label}: no results`);
      continue;
    }
    let downloaded = null;
    try {
      downloaded = await downloadClips({ candidates, topic, workDir, want, perShot, signal: cfg && cfg.signal, providerId: provider.id });
    } catch (e) {
      log.warn('stock', `${provider.label} download failed — trying the next provider`, e);
      notes.push(`${provider.label}: download failed (${e.message})`);
      continue;
    }
    if (downloaded) {
      log.info('stock', `downloaded ${downloaded.count} clip(s) from ${provider.label} for "${topic}"`);
      return { ...downloaded, stub: false };
    }
    notes.push(`${provider.label}: no clips could be downloaded`);
  }

  const reason = notes.length ? notes.join('; ') : 'no stock provider configured';
  log.warn('stock', `stock footage fell back to a stub (${reason})`);
  return stubShots(topic, reason);
}

/** The graceful placeholder: a shot list with file:null so the render step knows to skip it. */
function stubShots(topic, reason) {
  const shots = [
    { start: 0, end: 5, query: `${topic} establishing shot`, file: null, stub: true },
    { start: 5, end: 12, query: `${topic} b-roll`, file: null, stub: true },
    { start: 12, end: 20, query: `${topic} close-up`, file: null, stub: true },
  ];
  return {
    shots, stub: true, reason,
    todo: 'set PEXELS_API_KEY or PIXABAY_API_KEY (or cfg.pexelsApiKey / cfg.pixabayApiKey) for a keyed provider — Wikimedia Commons needs no key and runs automatically',
  };
}

module.exports = {
  findStockFootage, stubShots, slugify,
  parsePexels, parsePixabay, parseWikimedia, pickPexelsFile, pickPixabayFile, pickWikimediaFile,
  PROVIDERS,
};
