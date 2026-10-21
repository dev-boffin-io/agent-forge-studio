'use strict';

const { fromResponse, wrapNetwork, fetchOk, explain } = require('./errors');
const log = require('./log');
const { loadConfig } = require('./config');

const MAX_BYTES = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; youtube-forge-studio/1.0; +https://github.com/dev-boffin-io)';

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

async function search(query, { count = 8 } = {}) {
  const cfg = loadConfig();
  const provider = (cfg.websearch && cfg.websearch.provider) || 'exa';
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');
  if (provider === 'ddg') return searchDdg(cfg, q, count);
  if (provider === 'searxng') return searchSearxng(cfg, q, count);
  return searchExa(cfg, q, count);
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

module.exports = {
  fetchUrl, webfetch, webFetch,
  search, searchExa, searchDdg, searchSearxng,
  htmlToText, htmlToMarkdown, decodeEntities, isPrivateHost,
  stripHtml: htmlToText,
};
