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
const stockWeb = require('./stock-web');

const PEXELS_SEARCH = 'https://api.pexels.com/videos/search';
const PIXABAY_SEARCH = 'https://pixabay.com/api/videos/';
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia's API policy requires an identifying User-Agent.
const WIKIMEDIA_UA = 'YouTubeForgeStudio/1.0 (https://github.com/agent-forge-studio)';

/** Absolute workspace path for a relative artifact, falling back to cwd. */
function absUnder(workDir, relPath) {
  const base = workDir || process.cwd();
  return path.isAbsolute(relPath) ? relPath : path.join(base, relPath);
}

/** Slugify a topic into a safe folder name. Non-Latin topics (Bengali, Hindi, ...) get a short hash. */
function slugify(text) {
  const raw = String(text || 'video');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug) return slug;
  if (!String(text || '').trim()) return 'video';
  return `video-${require('node:crypto').createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Download limits. Clips outside [min,max] seconds, or bigger than maxClipMB, are never fetched. */
function clipLimits(cfg) {
  const sf = (cfg && cfg.stockFootage) || {};
  return { minSeconds: num(sf.minClipSeconds, 3), maxSeconds: num(sf.maxClipSeconds, 30), maxBytes: num(sf.maxClipMB, 60) * 1024 * 1024 };
}

/** landscape | portrait | square — from cfg.stockFootage.orientation, else from cfg.videoAspect. */
function resolveOrientation(cfg) {
  const sf = (cfg && cfg.stockFootage) || {};
  if (['landscape', 'portrait', 'square'].includes(sf.orientation)) return sf.orientation;
  const a = String((cfg && cfg.videoAspect) || '16:9').toLowerCase();
  if (/^(9[:x]16|4[:x]5|portrait|vertical|shorts|reels|tiktok)$/.test(a)) return 'portrait';
  if (/^(1[:x]1|square)$/.test(a)) return 'square';
  return 'landscape';
}

/** The shorter edge of a rendition; when the height is unknown assume 16:9. */
function shortSide(f) {
  const w = Number(f.width) || 0; const h = Number(f.height) || 0;
  if (w && h) return Math.min(w, h);
  return w ? Math.round((w * 9) / 16) : 0;
}

function matchesOrientation(f, orientation) {
  const w = Number(f.width) || 0; const h = Number(f.height) || 0;
  if (!w || !h || !orientation || orientation === 'square') return true;
  return orientation === 'portrait' ? h > w : w >= h;
}

/**
 * Pick the rendition that fits the target frame: right orientation, shorter edge closest to
 * 1080 (never a 4K download when 1080p exists, never below 720 unless nothing else). Returns
 * null when no rendition has the wanted orientation.
 */
function rankRendition(candidates, { orientation, targetShort = 1080 } = {}) {
  const pool = (candidates || []).filter((f) => matchesOrientation(f, orientation));
  if (!pool.length) return null;
  const score = (f) => { const s = shortSide(f); return s >= 720 ? Math.abs(s - targetShort) : 1000 + (720 - s); };
  return pool.slice().sort((a, b) => score(a) - score(b))[0];
}

/** Drop clips that are too long/short/big; clips with a known length come first. */
function selectCandidates(candidates, { minSeconds, maxSeconds, maxBytes }) {
  const ok = (candidates || []).filter((c) => {
    const d = Number(c.duration) || 0;
    if (d > 0 && (d < minSeconds || d > maxSeconds)) return false;
    if (c.bytes && c.bytes > maxBytes) return false;
    return true;
  });
  return [...ok.filter((c) => Number(c.duration) > 0), ...ok.filter((c) => !(Number(c.duration) > 0))];
}

// ---- Pexels adapter -------------------------------------------------------------------------

/** Best MP4 rendition for a Pexels video object. Exported for tests. */
function pickPexelsFile(video, opts = {}) {
  const files = Array.isArray(video && video.video_files) ? video.video_files : [];
  const mp4 = files.filter((f) => (f.file_type || '').includes('mp4') || /\.mp4($|\?)/i.test(f.link || ''));
  const pool = mp4.length ? mp4 : files;
  if (!pool.length) return null;
  return rankRendition(pool, opts);
}

/**
 * Parse a Pexels /videos/search body into downloadable candidates.
 * Exported for tests. Each candidate: {url, width, duration}.
 */
function parsePexels(body, opts = {}) {
  const videos = Array.isArray(body && body.videos) ? body.videos : [];
  const out = [];
  for (const v of videos) {
    const file = pickPexelsFile(v, opts);
    if (!file || !file.link) continue;
    out.push({ url: file.link, width: Number(file.width) || 0, height: Number(file.height) || 0, duration: Number(v.duration) || 0, bytes: Number(file.size) || 0 });
  }
  return out;
}

async function searchPexels({ topic, key, want, orientation, signal }) {
  const url = new URL(PEXELS_SEARCH);
  url.searchParams.set('query', String(topic || 'cinematic b-roll'));
  url.searchParams.set('per_page', String(Math.min(want * 4, 40)));   // over-fetch: many hits are too long
  url.searchParams.set('orientation', orientation);
  const res = await fetchOk(url.toString(), { headers: { Authorization: key }, signal }, { source: 'pexels', where: 'api.pexels.com' });
  return parsePexels(await res.json(), { orientation });
}

// ---- Pixabay adapter ------------------------------------------------------------------------

const PIXABAY_SIZES = ['large', 'medium', 'small', 'tiny'];

/**
 * Best MP4 rendition for a Pixabay hit. Pixabay nests renditions under `videos.{large,medium,...}`
 * with `{url,width,height,size,thumbnail}`; prefer the best available size.
 */
function pickPixabayFile(hit, opts = {}) {
  const videos = (hit && hit.videos) || {};
  const candidates = [];
  for (const size of PIXABAY_SIZES) {
    const v = videos[size];
    if (v && v.url) candidates.push({ width: Number(v.width) || 0, height: Number(v.height) || 0, url: v.url, bytes: Number(v.size) || 0 });
  }
  if (!candidates.length) return null;
  return rankRendition(candidates, opts);
}

/**
 * Parse a Pixabay /api/videos/ body into downloadable candidates.
 * Exported for tests. Each candidate: {url, width, duration}.
 */
function parsePixabay(body, opts = {}) {
  const hits = Array.isArray(body && body.hits) ? body.hits : [];
  const out = [];
  for (const hit of hits) {
    const file = pickPixabayFile(hit, opts);
    if (!file || !file.url) continue;
    out.push({ url: file.url, width: file.width, height: file.height, duration: Number(hit.duration) || 0, bytes: file.bytes });
  }
  return out;
}

async function searchPixabay({ topic, key, want, orientation, signal }) {
  const url = new URL(PIXABAY_SEARCH);
  url.searchParams.set('key', key);
  url.searchParams.set('q', String(topic || 'cinematic b-roll').slice(0, 100));
  url.searchParams.set('per_page', String(Math.max(3, Math.min(want * 4, 50))));   // Pixabay requires >= 3; over-fetch
  url.searchParams.set('safesearch', 'true');
  // Pixabay has no orientation param; request landscape-ish minimums instead.
  if (orientation === 'landscape') url.searchParams.set('min_width', '1280');
  const res = await fetchOk(url.toString(), { signal }, { source: 'pixabay', where: 'pixabay.com' });
  return parsePixabay(await res.json(), { orientation });
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
function pickWikimediaFile(imageinfo, opts = {}) {
  const infos = Array.isArray(imageinfo) ? imageinfo : [];
  const videos = infos.filter((i) => i && i.url && (i.mime ? /^video\//i.test(i.mime) : WIKIMEDIA_VIDEO_EXT.test(i.url)));
  if (!videos.length) return null;
  const mp4 = videos.filter((i) => /\.mp4(?:$|\?)/i.test(i.url) || (i.mime || '').includes('mp4'));
  return rankRendition(mp4.length ? mp4 : videos, opts);
}

/**
 * Parse a Wikimedia Commons API body (action=query, generator=search, prop=imageinfo) into
 * downloadable candidates. Exported for tests. Each candidate: {url, width, duration, ext}.
 * `query.pages` is an object keyed by pageid; each page carries `imageinfo: [{url,mime,...}]`.
 */
function parseWikimedia(body, opts = {}) {
  const pages = (body && body.query && body.query.pages) || {};
  const list = Array.isArray(pages) ? pages : Object.values(pages);
  const out = [];
  for (const page of list) {
    const file = pickWikimediaFile(page && page.imageinfo, opts);
    if (!file || !file.url) continue;
    out.push({
      url: file.url,
      width: Number(file.width) || 0,
      height: Number(file.height) || 0,
      duration: Number(file.duration) || 0,
      bytes: Number(file.size) || 0,
      ext: wikimediaExt(file.url),
    });
  }
  return out;
}

async function searchWikimedia({ topic, want, orientation, signal }) {
  const url = new URL(WIKIMEDIA_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrnamespace', '6');           // File: namespace
  url.searchParams.set('gsrsearch', `filetype:video ${String(topic || 'b-roll')}`);
  url.searchParams.set('gsrlimit', String(Math.max(1, Math.min(want * 3, 20))));   // over-fetch: Commons has many long videos
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|size');
  const res = await fetchOk(url.toString(), { headers: { 'User-Agent': WIKIMEDIA_UA }, signal }, { source: 'wikimedia', where: 'commons.wikimedia.org' });
  return parseWikimedia(await res.json(), { orientation });
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
    // Keyless public-page adapters. Pexels embeds its full result set in __NEXT_DATA__; Pixabay
    // often shows a Cloudflare challenge, so a failure simply falls through to Wikimedia.
    id: 'pexels-web',
    keyOf: () => 'keyless',
    search: stockWeb.searchPexelsWeb,
    label: 'Pexels (web, no key)',
    keyless: true,
  },
  {
    id: 'pixabay-web',
    keyOf: () => 'keyless',
    search: stockWeb.searchPixabayWeb,
    label: 'Pixabay (web, no key)',
    keyless: true,
  },
  {
    // Keyless: always available, so it runs whenever the other providers are absent or fail.
    id: 'wikimedia',
    keyOf: () => 'keyless',
    search: searchWikimedia,
    label: 'Wikimedia Commons',
  },
];

/**
 * Download a provider's candidates into `<workDir>/autoforge/<slug>/footage/` as a shot list.
 * Candidates are filtered by duration/size first; a clip over the size limit is skipped before
 * its body is read. Returns {shots, provider, count} or null when nothing could be downloaded.
 */
async function downloadClips({ candidates, topic, workDir, want, perShot, signal, providerId, limits, startIndex = 0 }) {
  const { maxSeconds, maxBytes } = limits || clipLimits({});
  const dirRel = path.join('autoforge', slugify(topic), 'footage');
  const dirAbs = absUnder(workDir, dirRel);
  fs.mkdirSync(dirAbs, { recursive: true });

  const shots = [];
  let cursor = 0;
  for (const c of selectCandidates(candidates, limits || clipLimits({}))) {
    if (!c.url) continue;
    const ext = c.ext || 'mp4';
    const provider = String(c.provider || providerId || 'stock').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const name = `${provider}-${String(startIndex + shots.length + 1).padStart(2, '0')}.${ext}`;
    const destAbs = path.join(dirAbs, name);
    try {
      const res = await fetchOk(c.url, { signal }, { source: provider, where: new URL(c.url).host });
      const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0) || 0;
      if (declared > maxBytes) throw new Error(`clip too large (${Math.round(declared / 1048576)} MB)`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty download');
      if (buf.length > maxBytes) throw new Error(`clip too large (${Math.round(buf.length / 1048576)} MB)`);
      fs.writeFileSync(destAbs, buf);
    } catch (e) {
      log.warn('stock', `could not download a ${provider} clip (${name})`, e);
      continue;
    }
    const dur = Number(c.duration) > 0 ? Number(c.duration) : perShot;
    const len = Math.min(dur, maxSeconds);
    shots.push({
      file: path.relative(workDir || process.cwd(), destAbs),
      start: Number(cursor.toFixed(2)),
      end: Number((cursor + len).toFixed(2)),
      query: String(topic || ''),
      provider,
      clipSeconds: Number(c.duration) > 0 ? Number(c.duration) : null,
      sourceUrl: c.url,
      pageUrl: c.pageUrl || null,
      title: c.title || '',
      license: c.license || null,
      tags: Array.isArray(c.tags) ? c.tags.slice(0, 12) : [],
      bytes: c.bytes || null,
      stub: false,
    });
    cursor += len;
    if (shots.length >= want) break;
  }
  return shots.length ? { shots, provider: providerId, count: shots.length } : null;
}

/** Run the Pexels → Pixabay → Wikimedia cascade for ONE search phrase. */
async function cascadeOnce({ query, cfg, want, orientation, limits, workDir, perShot, folderTopic, startIndex, notes }) {
  for (const provider of PROVIDERS) {
    const key = provider.keyOf(cfg);
    if (!key) {
      notes.push(`${provider.label}: no API key`);
      continue;
    }
    let candidates = [];
    try {
      candidates = await provider.search({ topic: query, key, want, orientation, signal: cfg && cfg.signal });
    } catch (e) {
      log.warn('stock', `${provider.label} search failed — trying the next provider`, e);
      notes.push(`${provider.label}: search failed (${e.message})`);
      continue;
    }
    if (!candidates.length) {
      log.warn('stock', `${provider.label} returned no clips for "${query}"`);
      notes.push(`${provider.label}: no results`);
      continue;
    }
    const usable = selectCandidates(candidates, limits);
    if (!usable.length) {
      notes.push(`${provider.label}: all ${candidates.length} clips were outside ${limits.minSeconds}-${limits.maxSeconds}s or too large`);
      continue;
    }
    let downloaded = null;
    try {
      downloaded = await downloadClips({ candidates, topic: folderTopic, workDir, want, perShot, signal: cfg && cfg.signal, providerId: provider.id, limits, startIndex });
    } catch (e) {
      log.warn('stock', `${provider.label} download failed — trying the next provider`, e);
      notes.push(`${provider.label}: download failed (${e.message})`);
      continue;
    }
    if (downloaded) return downloaded;
    notes.push(`${provider.label}: no clips could be downloaded`);
  }
  return null;
}

/**
 * Search stock footage with the provider cascade and download real clips when possible.
 *
 * @param {object} opts
 * @param {string} opts.topic
 * @param {string[]} [opts.queries] short ENGLISH search phrases; tried in order until `count` clips
 *                                  are collected (stock sites match English keywords far better)
 * @param {string} [opts.workDir]
 * @param {object} [opts.cfg]      cfg.videoAspect / cfg.stockFootage.{orientation,minClipSeconds,maxClipSeconds,maxClipMB}
 * @param {number} [opts.count]    how many clips to fetch (default 4)
 * @param {number} [opts.perShot]  seconds per shot when no duration is known (default 5)
 * @returns {{shots:Array, stub:boolean, provider?:string, count?:number, reason?:string, todo?:string}}
 */
async function findStockFootage({ topic = '', queries, workDir, cfg = {}, count = 4, perShot = 5 } = {}) {
  const want = Math.max(1, Math.min(Number(count) || 4, 10));
  const orientation = resolveOrientation(cfg);
  const limits = clipLimits(cfg);
  const notes = [];
  const phrases = [...new Set((Array.isArray(queries) ? queries : []).map((q) => String(q || '').trim()).filter(Boolean))];
  if (!phrases.length) phrases.push(String(topic || ''));
  const folderTopic = topic || phrases[0];

  const shots = [];
  let provider = null;
  for (const query of phrases) {
    if (shots.length >= want) break;
    const got = await cascadeOnce({ query, cfg, want: want - shots.length, orientation, limits, workDir, perShot, folderTopic, startIndex: shots.length, notes });
    if (got) { shots.push(...got.shots); provider = provider || got.provider; }
  }

  if (shots.length) {
    let cursor = 0;                                   // one continuous timeline across all queries
    for (const s of shots) {
      const len = s.end - s.start;
      s.start = Number(cursor.toFixed(2));
      s.end = Number((cursor + len).toFixed(2));
      cursor += len;
    }
    log.info('stock', `downloaded ${shots.length} clip(s) for "${folderTopic}" (${orientation}, ≤${limits.maxSeconds}s each)`);
    return { shots, provider, count: shots.length, orientation, stub: false };
  }

  const reason = notes.length ? [...new Set(notes)].join('; ') : 'no stock provider configured';
  log.warn('stock', `stock footage fell back to a stub (${reason})`);
  return stubShots(topic, reason);
}

/**
 * Download footage from manually supplied Pexels/Pixabay page URLs or direct media URLs. This is
 * the escape hatch for Pixabay's Cloudflare wall and for a human/agent choosing exact clips:
 * paste the page links (or direct cdn URLs) and they are resolved, downloaded and recorded with
 * their source page and licence.
 */
async function importStockFootage({ urls, topic = 'manual-footage', workDir, cfg = {}, count = 8, perShot = 5, signal } = {}) {
  const want = Math.max(1, Math.min(Number(count) || 8, 10));
  const orientation = resolveOrientation(cfg);
  const limits = clipLimits(cfg);
  const resolved = await stockWeb.resolveStockUrls({ urls, signal: signal || cfg.signal, want, orientation });
  if (!resolved.candidates.length) {
    const detail = resolved.errors.length ? ` (${resolved.errors.join('; ')})` : '';
    throw new Error(`no downloadable footage found in the supplied URL(s)${detail}`);
  }
  const downloaded = await downloadClips({
    candidates: resolved.candidates,
    topic,
    workDir,
    want,
    perShot,
    signal: signal || cfg.signal,
    providerId: 'manual',
    limits,
  });
  if (!downloaded) throw new Error('the supplied footage URLs could not be downloaded (check size/duration limits)');
  log.info('stock', `imported ${downloaded.count} manually sourced clip(s) for "${topic}"`);
  return {
    ...downloaded,
    provider: 'manual',
    source: 'manual',
    orientation,
    errors: resolved.errors,
    stub: false,
  };
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
    todo: 'PEXELS_API_KEY / PIXABAY_API_KEY are optional: keyless Pexels/Pixabay web search and Wikimedia ran automatically. If the sites blocked the request, open a Pexels/Pixabay video page manually and pass its URL to footage_import (no API key needed)',
  };
}

module.exports = {
  findStockFootage, importStockFootage, stubShots, slugify,
  parsePexels, parsePixabay, parseWikimedia, pickPexelsFile, pickPixabayFile, pickWikimediaFile,
  selectCandidates, rankRendition, clipLimits, resolveOrientation,
  PROVIDERS,
};
