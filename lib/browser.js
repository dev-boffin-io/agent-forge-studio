'use strict';

// Browser — one shared, *visible* Chromium window the agent drives like a human, for the parts
// of YouTube Studio the Data API cannot reach (channel customization, end screens, cards,
// some upload flows). Playwright is required but lazily loaded, so the studio still boots
// without it. Login survives restarts: cookies + localStorage are persisted as a Playwright
// storage state in the studio data dir (…/<channel>/browser/youtube.auth.json).

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { studioDir } = require('./config');

const AUTH_DIR = () => path.join(studioDir(), 'browser');
const AUTH_FILE = () => path.join(AUTH_DIR(), 'youtube.auth.json');
const AUTOSAVE_EVERY = 4;      // persist the login every N human actions
const DEFAULT_TIMEOUT_MS = 20000;

let browser = null;
let context = null;
let page = null;
let actionsSinceSave = 0;

function havePlaywright() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

function authInfo() {
  const file = AUTH_FILE();
  try {
    const st = fs.statSync(file);
    return { file, exists: true, bytes: st.size, savedAt: st.mtime.toISOString() };
  } catch { return { file, exists: false, bytes: 0, savedAt: null }; }
}

/** Launch (or reuse) the visible browser with the saved login, if any. */
async function ensureBrowser({ headless = false } = {}) {
  if (page && !page.isClosed() && context) return { browser, context, page };
  if (!havePlaywright()) {
    throw new Error('playwright is not installed — run: npm install playwright && npx playwright install chromium');
  }
  const { chromium } = require('playwright');
  const baseArgs = ['--start-maximized', '--disable-blink-features=AutomationControlled'];
  // Headless (CI/sandbox) often has no usable GPU — without these the GPU process SIGTRAPs
  // after a few retries and kills the whole browser mid-action. Headed keeps GPU so Studio
  // renders smoothly on a real desktop.
  const headlessArgs = ['--disable-gpu', '--disable-gpu-process-crash-limit', '--no-sandbox', '--disable-dev-shm-usage'];
  browser = await chromium.launch({
    headless,
    args: headless ? [...baseArgs, ...headlessArgs] : baseArgs,
  });
  const auth = authInfo();
  context = await browser.newContext({
    viewport: null,                        // real window size, like a human
    storageState: auth.exists ? auth.file : undefined,
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  // mask automation flags a bit — YouTube is picky
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  context.on('close', () => { context = null; browser = null; page = null; });
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.on('close', () => { page = null; });
  log.info('browser', `chromium launched (headless=${headless}, auth=${auth.exists ? 'restored from ' + auth.file : 'fresh'})`);
  return { browser, context, page };
}

async function getPage(opts) {
  const { page: p } = await ensureBrowser(opts);
  if (!p || p.isClosed()) {
    page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  }
  return page;
}

/** Persist cookies + localStorage so the next launch is still logged in. */
async function saveState() {
  if (!context) return authInfo();
  fs.mkdirSync(AUTH_DIR(), { recursive: true });
  await context.storageState({ path: AUTH_FILE() });
  actionsSinceSave = 0;
  return authInfo();
}

async function maybeAutosave() {
  actionsSinceSave++;
  if (actionsSinceSave >= AUTOSAVE_EVERY) await saveState();
}

/** close(): persist first. The user can keep the window open — we only close what we opened. */
async function closeBrowser({ save = true } = {}) {
  try { if (save && context) await saveState(); } catch (e) { log.warn('browser', 'could not persist browser state', e); }
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  browser = null; context = null; page = null; actionsSinceSave = 0;
  return { closed: true, auth: authInfo() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
/** Small random pause so actions do not fire like a machine-gun. */
function humanPause(p, min = 90, max = 260) { return sleep(min + Math.random() * (max - min)); }

/**
 * Resolve a selector string to a Playwright locator. Supported forms (all pierce open shadow DOM):
 *   css:  "ytcp-button#upload button"        — plain CSS
 *   text: 'text=Create'  |  'text="exact"'   — Playwright text engine
 *   role: 'role=button[name="Create"]'       — Playwright role engine
 *   xpath:"//button[.='Create']"             — xpath= prefix (or a bare //… string)
 *   aria: 'aria-label=Upload videos'         — attribute-style convenience
 */
function locate(p, selector) {
  const s = String(selector || '').trim();
  if (!s) throw new Error('empty selector');
  if (s.startsWith('//') || s.startsWith('(//')) return p.locator('xpath=' + s);
  return p.locator(s);
}

/** First visible match, with a helpful error listing close candidates. */
async function visible(p, selector, { timeoutMs } = {}) {
  const loc = locate(p, selector);
  try {
    await loc.first().waitFor({ state: 'visible', timeout: timeoutMs || DEFAULT_TIMEOUT_MS });
  } catch (e) {
    const near = await nearbyLabels(p, selector).catch(() => []);
    throw new Error(`no visible element for ${selector}` + (near.length ? ` — nearby: ${near.slice(0, 6).join(' | ')}` : ''));
  }
  return loc.first();
}

/** Best-effort "what else looks like that" hint for a failed selector. */
async function nearbyLabels(p, selector) {
  const needle = String(selector).toLowerCase().replace(/^(text|aria-label)=/, '').replace(/["']/g, '').slice(0, 40);
  if (!needle) return [];
  return p.evaluate((n) => {
    const out = [];
    const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    for (const el of document.querySelectorAll('button,a[href],input,select,textarea,[role=button],[role=tab],[role=link],[role=menuitem],[role=radio]')) {
      const label = name(el);
      if (label && label.toLowerCase().includes(n)) out.push(label);
      if (out.length >= 10) break;
    }
    return out;
  }, needle);
}

/**
 * A compact, LLM-friendly outline of the current page: interactive elements with role, name,
 * and a selector you can paste back into click/type. YouTube Studio is full of shadow DOM —
 * this walks it. Returns {url, title, elements:[{role,name,tag,selector}], text?}.
 */
async function snapshot(p, { maxElements = 220, includeText = false } = {}) {
  const data = await p.evaluate(({ max, text: includeText }) => {
    const out = [];
    const seen = new Set();
    const push = (el, role) => {
      if (out.length >= max) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const key = role + '|' + name + '|' + el.tagName;
      if (!name || seen.has(key)) return;
      seen.add(key);
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).map((c) => '.' + c).join('') : '';
      let selector = null;
      if (el.id) selector = el.id.startsWith('/') ? null : `#${CSS.escape(el.id)}`;
      else if (el.tagName === 'INPUT' && el.type === 'file') selector = 'input[type=file]';
      else if (el.getAttribute('aria-label')) selector = `aria-label=${JSON.stringify(el.getAttribute('aria-label'))}`;
      else if (el.getAttribute('placeholder')) selector = `${el.tagName.toLowerCase()}[placeholder=${JSON.stringify(el.getAttribute('placeholder'))}]`;
      out.push({ role, name, tag: el.tagName.toLowerCase() + id + cls, selector });
    };
    const walk = (root, depth) => {
      if (depth > 24 || out.length >= max * 2) return;
      let els;
      try { els = root.querySelectorAll ? root.querySelectorAll('*') : []; } catch { return; }
      for (const el of els) {
        if (out.length >= max * 2) break;
        const role = el.getAttribute && el.getAttribute('role');
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'button' || role === 'button') push(el, 'button');
        else if (tag === 'a' && el.href) push(el, 'link');
        else if (tag === 'input') push(el, 'input:' + (el.type || 'text'));
        else if (tag === 'select') push(el, 'select');
        else if (tag === 'textarea') push(el, 'textarea');
        else if (role && role !== 'presentation' && role !== 'none') push(el, role);
        else if (tag === 'label') push(el, 'label');
        const sr = el.shadowRoot;
        if (sr && depth < 24) walk(sr, depth + 1);
      }
    };
    walk(document, 0);
    const bodyText = includeText ? (document.body ? document.body.innerText : '').slice(0, 6000) : '';
    return { url: location.href, title: document.title, elements: out.slice(0, max), text: bodyText };
  }, { max: maxElements, text: !!includeText });
  return data;
}

/** Human-ish click: real mouse move + small pauses around the click. */
async function humanClick(loc) {
  const box = await loc.boundingBox();
  if (box) {
    const x = box.x + box.width * (0.35 + Math.random() * 0.3);
    const y = box.y + box.height * (0.35 + Math.random() * 0.3);
    await loc.page().mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) });
    await sleep(60 + Math.random() * 120);
  }
  await loc.click({ delay: 20 + Math.floor(Math.random() * 60) });
}

/** Human-ish typing: key-by-key with a natural inter-key delay. */
async function humanType(loc, text, { delayMs } = {}) {
  const delay = delayMs != null ? Number(delayMs) : 35 + Math.floor(Math.random() * 55);
  await loc.click();
  await loc.pressSequentially(String(text), { delay });
}

/**
 * Download a file through the shared browser session.
 * - with a selector: click the control and capture the Playwright download event;
 * - with a URL: fetch it through the browser context (keeps cookies / login).
 * Returns {buffer, filename, contentType, url}.
 */
async function downloadVia(p, { url, selector, timeoutMs = 60000 } = {}) {
  if (!url && !selector) throw new Error('browser_download needs a url or a selector');
  if (selector) {
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: Number(timeoutMs) || 60000 }),
      (async () => {
        const loc = await visible(p, selector);
        await humanClick(loc);
      })(),
    ]);
    const file = await dl.path();
    if (!file) throw new Error('the browser reported a download but produced no file');
    return {
      buffer: fs.readFileSync(file),
      filename: dl.suggestedFilename() || 'download',
      contentType: '',
      url: dl.url() || p.url(),
    };
  }
  const res = await p.context().request.get(String(url), { timeout: Number(timeoutMs) || 60000 });
  if (!res.ok()) throw new Error(`download failed: HTTP ${res.status()} from ${url}`);
  return {
    buffer: Buffer.from(await res.body()),
    filename: (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; } })(),
    contentType: res.headers()['content-type'] || '',
    url: String(url),
  };
}

module.exports = {
  AUTH_FILE, havePlaywright, authInfo,
  ensureBrowser, getPage, saveState, maybeAutosave, closeBrowser,
  locate, visible, snapshot, humanClick, humanType, humanPause, downloadVia, sleep,
};
