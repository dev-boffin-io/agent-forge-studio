'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fromResponse, wrapNetwork, fetchOk, explain } = require('./errors');
const log = require('./log');
const { loadConfig } = require('./config');

const MAX_BYTES = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; agent-forge-studio/1.0; +https://github.com/dev-boffin-io)';

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
  'audio/wav': '.wav', 'application/pdf': '.pdf', 'application/json': '.json',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'text/html': '.html',
};

const decodeEntities = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function htmlToText(html) {
  return decodeEntities(String(html).replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Small HTML -> Markdown converter (headings, links, lists, code, emphasis). */
function htmlToMarkdown(html) {
  let h = String(html).replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + decodeEntities(c.replace(/<[^>]+>/g, '')) + '\n```\n');
  h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`');
  for (let i = 1; i <= 6; i++) h = h.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'), (_, c) => `\n\n${'#'.repeat(i)} ${c.replace(/<[^>]+>/g, '').trim()}\n\n`);
  h = h.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => { const text = t.replace(/<[^>]+>/g, '').trim(); return text ? `[${text}](${href})` : ''; });
  h = h.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  h = h.replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|ul|ol|table|section|article)>/gi, '\n\n').replace(/<\/t[dh]>/gi, ' | ');
  return decodeEntities(h.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
const isPrivateHost = (url) => { try { return PRIVATE_HOST.test(new URL(url).hostname); } catch { return false; } };

async function fetchUrl(url, { maxChars = 20000, timeoutMs = 30000 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a valid URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`only http(s) URLs are supported: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchOk(url, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    }, { source: 'webfetch', where: u.host });
    const ctype = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (/text\/plain|text\/markdown/i.test(ctype)) {
      return { url, title: '', text: raw.length > maxChars ? raw.slice(0, maxChars) + '\n…[truncated]' : raw, contentType: ctype };
    }
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const text = /text\/html|application\/xhtml/.test(ctype) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToMarkdown(raw) : raw;
    return { url, title, text: text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text, contentType: ctype };
  } catch (e) {
    throw new Error(explain(e, u.host));
  } finally { clearTimeout(timer); }
}

// legacy-compatible names used by some tests
const webfetch = fetchUrl;
const webFetch = fetchUrl;

function hasSearchKey(cfg, provider) {
  if (provider === 'exa') return !!(process.env.EXA_API_KEY || (cfg.websearch && cfg.websearch.apiKey));
  if (provider === 'searxng') return !!(process.env.SEARXNG_URL || (cfg.websearch && cfg.websearch.url));
  return true;
}

/**
 * Search the open web. Tries the configured provider first, then falls back through the
 * keyless providers so a missing API key never blocks research.
 */
async function search(query, { count = 8 } = {}) {
  const cfg = loadConfig();
  const configured = (cfg.websearch && cfg.websearch.provider) || 'ddg';
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');
  const chain = [configured, 'ddg', 'wikipedia', 'exa', 'searxng'].filter((p, i, a) => a.indexOf(p) === i);
  let lastErr;
  for (const provider of chain) {
    if (!hasSearchKey(cfg, provider)) { lastErr = lastErr || new Error(`${provider} is not configured`); continue; }
    try {
      if (provider === 'ddg') return await searchDdg(cfg, q, count);
      if (provider === 'wikipedia') return await searchWikipedia(cfg, q, count);
      if (provider === 'searxng') return await searchSearxng(cfg, q, count);
      return await searchExa(cfg, q, count);
    } catch (e) {
      lastErr = e;
      log.warn('websearch', `${provider} failed (${e.message}); trying the next provider`);
    }
  }
  throw lastErr || new Error('no search provider is available');
}

async function searchExa(cfg, query, count) {
  const key = process.env.EXA_API_KEY || (cfg.websearch && cfg.websearch.apiKey) || '';
  if (!key) throw new Error('exa needs an API key — set EXA_API_KEY or websearch.apiKey in settings');
  const res = await fetchOk('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: count, type: 'auto' }),
  }, { source: 'exa', where: 'api.exa.ai' });
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.text ? String(r.text).slice(0, 400) : (r.snippet || '') }));
}

async function searchDdg(cfg, query, count) {
  const res = await fetchOk('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'q=' + encodeURIComponent(query),
  }, { source: 'ddg', where: 'duckduckgo.com' });
  const html = await res.text();
  const out = [];
  const rx = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)/gi;
  let m;
  while ((m = rx.exec(html)) && out.length < count) {
    let href = m[1];
    const uddg = /uddg=([^&]+)/.exec(href);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* keep */ } }
    out.push({ title: htmlToText(m[2]), url: href, snippet: htmlToText(m[3]) });
  }
  if (!out.length) throw new Error('duckduckgo returned no parseable results (layout change or blocked)');
  return out;
}

/** Keyless last-resort search via the Wikipedia OpenSearch API. */
async function searchWikipedia(cfg, query, count) {
  const url = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=' + Math.min(20, Math.max(1, count))
    + '&search=' + encodeURIComponent(query);
  const res = await fetchOk(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  }, { source: 'wikipedia', where: 'en.wikipedia.org' });
  const data = await res.json();
  const [, titles = [], snippets = [], urls = []] = data;
  const out = titles.map((title, i) => ({ title, url: urls[i] || '', snippet: snippets[i] || '' })).filter((r) => r.url);
  if (!out.length) throw new Error('wikipedia returned no results');
  return out.slice(0, count);
}

async function searchSearxng(cfg, query, count) {
  const base = (cfg.websearch && cfg.websearch.url) || process.env.SEARXNG_URL || '';
  if (!base) throw new Error('searxng needs a base URL — set websearch.url in settings');
  const res = await fetchOk(base.replace(/\/+$/, '') + '/search?format=json&q=' + encodeURIComponent(query), {
    method: 'GET',
    headers: { 'user-agent': UA, accept: 'application/json' },
  }, { source: 'searxng', where: base });
  const data = await res.json();
  return (data.results || []).slice(0, count).map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.content ? String(r.content).slice(0, 400) : '' }));
}

/** Strip directories, control characters and platform-reserved characters from a file name. */
function safeFilename(name, fallback = 'download') {
  let base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  base = base.replace(/[\x00-\x1f<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 180);
  return base || fallback;
}

function filenameFromDisposition(header) {
  const h = String(header || '');
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(h);
  if (star) {
    try { return safeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(h);
  if (plain) return safeFilename((plain[1] || plain[2] || '').trim());
  return '';
}

function filenameFromUrl(url, contentType = '') {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return safeFilename(last);
  } catch { /* ignore */ }
  return 'download' + (EXT_BY_TYPE[String(contentType).split(';')[0].trim()] || '');
}

/**
 * Download a file from the open internet into the channel workspace.
 * Returns {ok, path, url, contentType, bytes}. Honours the same private-host protection as webfetch.
 */
async function downloadUrl(url, { destDir = 'downloads', filename, maxBytes = MAX_BYTES, overwrite = false, timeoutMs = 60000 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a valid URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`only http(s) URLs are supported: ${url}`);
  if (isPrivateHost(url)) throw new Error(`refusing to download from a private/local address: ${u.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchOk(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: '*/*' },
    }, { source: 'download', where: u.host });

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`file is too large (${declared} bytes; limit ${maxBytes})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`file is too large (${buf.length} bytes; limit ${maxBytes})`);

    const ws = require('./workspace');
    const preferred = safeFilename(filename || filenameFromDisposition(res.headers.get('content-disposition')) || filenameFromUrl(u.href, contentType));
    const dir = destDir == null ? 'downloads' : String(destDir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const targetFor = (name) => (dir ? path.posix.join(dir, name) : name);
    let target = targetFor(preferred);
    let abs = ws.safeResolve(target);
    if (!overwrite) {
      let n = 2;
      const ext = path.extname(preferred);
      const stem = ext ? preferred.slice(0, -ext.length) : preferred;
      while (fs.existsSync(abs)) {
        target = targetFor(`${stem}-${n++}${ext}`);
        abs = ws.safeResolve(target);
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    return { ok: true, path: ws.rel(abs), url: u.href, contentType, bytes: buf.length, filename: path.basename(abs) };
  } catch (e) {
    throw new Error(explain(e, u.host));
  } finally { clearTimeout(timer); }
}

/**
 * Search the web and read the top results in one call — the agent's research primitive.
 * A failed page does not fail the whole research run; its error is reported per result.
 */
async function research(query, { count = 8, fetchCount = 4, maxChars = 8000 } = {}) {
  const results = await search(query, { count });
  const n = Math.max(0, Math.min(results.length, Number(fetchCount) || 0));
  const pages = await Promise.all(results.slice(0, n).map(async (r) => {
    if (!r.url) return { ...r, error: 'no url' };
    try {
      const page = await fetchUrl(r.url, { maxChars });
      return { ...r, title: page.title || r.title, content: page.text, fetched: true };
    } catch (e) {
      return { ...r, error: explain(e, r.url), fetched: false };
    }
  }));
  return { query: String(query), results: pages.concat(results.slice(n).map((r) => ({ ...r, fetched: false }))), fetched: n };
}

module.exports = {
  fetchUrl, webfetch, webFetch,
  search, searchExa, searchDdg, searchWikipedia, searchSearxng,
  downloadUrl, research, safeFilename, filenameFromDisposition, filenameFromUrl,
  htmlToText, htmlToMarkdown, decodeEntities, isPrivateHost,
  stripHtml: htmlToText,
};
