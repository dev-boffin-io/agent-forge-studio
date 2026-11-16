'use strict';

// stock-web — keyless stock-footage discovery from the public Pexels/Pixabay websites and
// manual URL import. The official APIs need keys; the public pages do not. Pexels embeds its
// full result set in __NEXT_DATA__, so it can be parsed directly. Pixabay sits behind
// Cloudflare, so this module accepts whatever public HTML it can reach, direct CDN URLs, and
// page URLs that the caller obtained manually (for example with the browser tool).
//
// Nothing here bypasses authentication, paywalls or CAPTCHAs. It only reads public pages and
// public media URLs, and always records the source page/licence for attribution.

const { fetchOk } = require('./errors');
const { isPrivateHost } = require('./web');

const PEXELS_WEB = 'https://www.pexels.com/search/videos/';
const PIXABAY_WEB = 'https://pixabay.com/videos/search/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?:$|[?#])/i;

function decodeEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, '&').replace(/&#38;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');
}

function shortSide(c) {
  const w = Number(c && c.width) || 0;
  const h = Number(c && c.height) || 0;
  return w && h ? Math.min(w, h) : (w || 0);
}

function orientationOk(c, orientation) {
  const w = Number(c && c.width) || 0;
  const h = Number(c && c.height) || 0;
  if (!w || !h || !orientation || orientation === 'square') return true;
  return orientation === 'portrait' ? h > w : w >= h;
}

/** Pick the rendition closest to 1080 on the short edge, preferring the requested orientation. */
function bestRendition(files, { orientation, targetShort = 1080 } = {}) {
  const pool = (files || []).filter((f) => f && f.url && VIDEO_EXT.test(f.url));
  const oriented = pool.filter((f) => orientationOk(f, orientation));
  const usable = oriented.length ? oriented : pool;
  if (!usable.length) return null;
  const score = (f) => {
    const s = shortSide(f);
    return s >= 720 ? Math.abs(s - targetShort) : 10000 - s;
  };
  return usable.slice().sort((a, b) => score(a) - score(b))[0];
}

function normalizeFile(f, fallback = {}) {
  if (!f) return null;
  const url = decodeEntities(f.link || f.url || f.src || f.contentUrl || '');
  if (!url) return null;
  return {
    url,
    width: Number(f.width || fallback.width) || 0,
    height: Number(f.height || fallback.height) || 0,
    bytes: Number(f.size || f.bytes || fallback.bytes) || 0,
    ext: (VIDEO_EXT.exec(url) || [])[1] || 'mp4',
  };
}

function pexelsVideoFiles(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const candidates = [];
  if (Array.isArray(obj.video_files)) candidates.push(...obj.video_files);
  if (obj.video && Array.isArray(obj.video.video_files)) candidates.push(...obj.video.video_files);
  if (obj.attributes && Array.isArray(obj.attributes.video_files)) candidates.push(...obj.attributes.video_files);
  if (obj.attributes && obj.attributes.video && Array.isArray(obj.attributes.video.video_files)) {
    candidates.push(...obj.attributes.video.video_files);
  }
  return candidates;
}

function pexelsItem(obj, opts = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const a = obj.attributes && typeof obj.attributes === 'object' ? obj.attributes : obj;
  const files = pexelsVideoFiles(obj).map((f) => normalizeFile(f, { width: a.width, height: a.height }));
  const file = bestRendition(files.filter(Boolean), opts);
  if (!file) return null;
  const id = a.id || obj.id || '';
  const slug = a.slug || obj.slug || '';
  const pageUrl = a.url || obj.url || (id ? `https://www.pexels.com/video/${slug ? encodeURIComponent(slug) + '-' : ''}${id}/` : '');
  const tags = Array.isArray(a.tags) ? a.tags.map((t) => (typeof t === 'string' ? t : t && (t.name || t.search_term))).filter(Boolean) : [];
  return {
    ...file,
    duration: Number(a.duration || obj.duration) || 0,
    provider: 'pexels',
    title: String(a.title || obj.title || '').trim(),
    description: String(a.description || obj.description || '').trim(),
    pageUrl,
    license: 'Pexels License',
    tags,
  };
}

function pixabayItem(obj, opts = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const videos = obj.videos && typeof obj.videos === 'object' ? obj.videos : null;
  let files = [];
  if (videos) {
    for (const size of ['large', 'medium', 'small', 'tiny']) {
      if (videos[size]) files.push(normalizeFile(videos[size]));
    }
  }
  if (obj.video && typeof obj.video === 'object') files.push(normalizeFile(obj.video));
  files = files.filter(Boolean);
  const file = bestRendition(files, opts);
  if (!file) return null;
  const id = obj.id || obj.videoId || '';
  return {
    ...file,
    duration: Number(obj.duration) || 0,
    provider: 'pixabay',
    title: String(obj.title || obj.tags || '').trim(),
    description: String(obj.description || '').trim(),
    pageUrl: obj.pageURL || obj.pageUrl || (id ? `https://pixabay.com/videos/id-${id}/` : ''),
    license: 'Pixabay Content License',
    tags: String(obj.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function walk(value, visit, depth = 0) {
  if (!value || depth > 40) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  visit(value);
  for (const item of Object.values(value)) walk(item, visit, depth + 1);
}

/** Parse any JSON <script> blocks (Pexels uses __NEXT_DATA__; other pages use JSON-LD). */
function embeddedJson(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!body || body.length > 8_000_000) continue;
    if (!/json/i.test(attrs) && !body.startsWith('{') && !body.startsWith('[')) continue;
    try { out.push(JSON.parse(body)); } catch { /* not JSON */ }
  }
  return out;
}

function collectPexels(html, opts) {
  const out = [];
  const seen = new Set();
  for (const root of embeddedJson(html)) {
    walk(root, (obj) => {
      const item = pexelsItem(obj, opts);
      if (!item || seen.has(item.url)) return;
      seen.add(item.url);
      out.push(item);
    });
  }
  return out;
}

function collectPixabay(html, opts) {
  const out = [];
  const seen = new Set();
  for (const root of embeddedJson(html)) {
    walk(root, (obj) => {
      const item = pixabayItem(obj, opts);
      if (!item || seen.has(item.url)) return;
      seen.add(item.url);
      out.push(item);
    });
  }
  return out;
}

function directUrls(html) {
  const text = decodeEntities(String(html || '').replace(/\\\//g, '/'));
  const out = [];
  const seen = new Set();
  const re = /https:\/\/(?:videos\.pexels\.com\/video-files|cdn\.pixabay\.com\/video)\/[^\s"'<>\\]+/gi;
  let m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[),.;]+$/, '');
    if (!VIDEO_EXT.test(url) || seen.has(url)) continue;
    seen.add(url);
    const provider = url.includes('pixabay.com') ? 'pixabay' : 'pexels';
    out.push({
      url, width: 0, height: 0, bytes: 0, duration: 0, provider,
      ext: (VIDEO_EXT.exec(url) || [])[1] || 'mp4',
      title: '', description: '',
      pageUrl: '', license: provider === 'pixabay' ? 'Pixabay Content License' : 'Pexels License', tags: [],
    });
  }
  return out;
}

/**
 * Parse a Pexels/Pixabay public page into candidates.
 * Exported for tests. Returns [{url,width,height,duration,provider,pageUrl,license,...}].
 */
function parseStockPage(html, pageUrl = '', opts = {}) {
  const text = String(html || '');
  const pexels = collectPexels(text, opts);
  const pixabay = collectPixabay(text, opts);
  const direct = directUrls(text);
  const all = [...pexels, ...pixabay, ...direct];
  const seen = new Set();
  const out = [];
  for (const c of all) {
    if (!c || !c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    if (!c.pageUrl && pageUrl && !VIDEO_EXT.test(pageUrl)) c.pageUrl = pageUrl;
    out.push(c);
  }
  return out;
}

/** True when the URL is a downloadable media file rather than an HTML page. */
function isDirectVideoUrl(url) {
  try {
    const u = new URL(String(url));
    return VIDEO_EXT.test(u.pathname);
  } catch { return false; }
}

function providerFor(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^www\./, '');
    if (host.endsWith('pexels.com')) return 'pexels';
    if (host.endsWith('pixabay.com')) return 'pixabay';
  } catch { /* ignore */ }
  return 'manual';
}

async function fetchPage(url, signal) {
  const host = new URL(url).host;
  if (isPrivateHost(url)) throw new Error(`refusing to fetch a private/local address: ${host}`);
  try {
    const res = await fetchOk(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
    }, { source: 'stock-web', where: host });
    if (typeof res.text === 'function') return res.text();
    if (typeof res.json === 'function') return JSON.stringify(await res.json());
    return '';
  } catch (e) {
    const status = e && e.status ? `HTTP ${e.status}` : 'request failed';
    throw new Error(`${host} blocked the automated ${status}. Open the page in your browser and pass a direct .mp4/.webm CDN URL to footage_import instead (no API key needed)`);
  }
}

async function searchPexelsWeb({ topic, want, orientation, signal }) {
  const url = new URL(PEXELS_WEB + encodeURIComponent(String(topic || 'cinematic b-roll')) + '/');
  url.searchParams.set('orientation', orientation || 'landscape');
  const html = await fetchPage(url.toString(), signal);
  const candidates = parseStockPage(html, url.toString(), { orientation });
  return candidates.filter((c) => c.provider === 'pexels').slice(0, Math.max(1, Number(want) || 8));
}

async function searchPixabayWeb({ topic, want, orientation, signal }) {
  const url = new URL(PIXABAY_WEB + encodeURIComponent(String(topic || 'cinematic b-roll')) + '/');
  const html = await fetchPage(url.toString(), signal);
  const candidates = parseStockPage(html, url.toString(), { orientation });
  if (!candidates.length) {
    throw new Error('Pixabay returned a challenge page instead of results — open the page in your browser and pass a direct cdn.pixabay.com video URL to footage_import');
  }
  return candidates.filter((c) => c.provider === 'pixabay').slice(0, Math.max(1, Number(want) || 8));
}

/**
 * Resolve manual URLs into downloadable candidates. Page URLs are fetched and parsed; direct
 * video URLs are returned as-is. Non-stock pages are accepted if they contain a video URL/meta.
 */
async function resolveStockUrls({ urls, signal, want = 8, orientation } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').trim()).filter(Boolean))].slice(0, 20);
  const out = [];
  const errors = [];
  for (const url of list) {
    if (isDirectVideoUrl(url)) {
      if (isPrivateHost(url)) {
        errors.push(`${url}: refusing to fetch a private/local address`);
        continue;
      }
      const provider = providerFor(url);
      out.push({
        url, width: 0, height: 0, bytes: 0, duration: 0, provider,
        ext: (VIDEO_EXT.exec(url) || [])[1] || 'mp4',
        title: '', description: '', pageUrl: '', tags: [],
        license: provider === 'pixabay' ? 'Pixabay Content License' : (provider === 'pexels' ? 'Pexels License' : 'unknown'),
      });
      continue;
    }
    try {
      const html = await fetchPage(url, signal);
      const parsed = parseStockPage(html, url, { orientation });
      if (!parsed.length) throw new Error('no public video files found on the page');
      out.push(...parsed);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
    if (out.length >= want) break;
  }
  const seen = new Set();
  const unique = out.filter((c) => c && c.url && !seen.has(c.url) && seen.add(c.url));
  return { candidates: unique.slice(0, Math.max(1, Number(want) || 8)), errors };
}

module.exports = {
  PEXELS_WEB, PIXABAY_WEB,
  parseStockPage, resolveStockUrls, isDirectVideoUrl, providerFor,
  searchPexelsWeb, searchPixabayWeb, bestRendition, orientationOk,
};
