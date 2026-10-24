'use strict';

// Workspace — all filesystem access for file tools goes through here. The agent works inside the
// channel folder (the working directory at launch). Studio-internal data (logs, tool output,
// sessions) lives under ~/.ytstudio/<channel>/ and is addressed in tool paths with the virtual
// prefix ".ytstudio/", e.g. ".ytstudio/tool-output/big.json" — never by an absolute path, so a
// model cannot wander outside the workspace by writing "/etc/passwd".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getWorkDir, studioDir, VIRTUAL_PREFIX } = require('./config');

const MAX_READ_BYTES = 2 * 1024 * 1024;   // refuse to load absurd files into the context
const MAX_LIST = 500;

function outside(p) { return Object.assign(new Error(`path escapes the workspace: ${p}`), { code: 'EACCES', outside: true }); }

/**
 * Resolve a tool-supplied path to an absolute one, confined to the channel workspace.
 * Supports the ".ytstudio/" virtual prefix for studio-internal files.
 */
function safeResolve(p) {
  const raw = String(p || '').trim();
  if (!raw) throw new Error('empty path');
  if (raw.startsWith('/')) throw outside(raw);
  if (raw.startsWith('~')) throw outside(raw);
  if (raw.split('/').includes('..')) throw outside(raw);
  if (raw === VIRTUAL_PREFIX || raw.startsWith(VIRTUAL_PREFIX + '/')) {
    const sub = raw.slice(VIRTUAL_PREFIX.length).replace(/^\/+/, '');
    if (sub.split('/').includes('..')) throw outside(raw);
    return path.join(studioDir(), sub);
  }
  return path.join(getWorkDir(), raw);
}

/** path relative to the workspace root, for display */
function rel(abs) {
  const w = getWorkDir();
  if (abs === w) return '.';
  if (abs.startsWith(w + path.sep)) return path.relative(w, abs) || '.';
  const s = studioDir();
  if (abs === s || abs.startsWith(s + path.sep)) return VIRTUAL_PREFIX + (abs === s ? '' : '/' + path.relative(s, abs));
  return abs;
}

function stat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function listDir(abs, { recursive = false, max = MAX_LIST } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      const r = rel(full);
      if (e.isDirectory()) {
        out.push({ path: r + '/', type: 'dir' });
        if (recursive && depth < 8) walk(full, depth + 1);
      } else {
        const st = stat(full);
        out.push({ path: r, type: 'file', size: st ? st.size : 0 });
      }
    }
  };
  walk(abs, 0);
  return out;
}

function expandBraces(pat) {
  const m = /\{([^{}]+)\}/.exec(pat);
  if (!m) return [pat];
  const parts = m[1].split(',');
  const out = [];
  for (const part of parts) {
    for (const base of expandBraces(pat.replace(m[0], part))) out.push(base);
  }
  return out;
}

function globToRegex(pat) {
  let body = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') { body += '(?:.*/)?'; i += 2; } else { body += '.*'; i++; }
      } else body += '[^/]*';
    } else if (ch === '?') {
      body += '[^/]';
    } else {
      body += /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
    }
  }
  return new RegExp('^' + body + '$', 'i');
}

/** glob-ish: '*' and '**' and '?' — relative to the workspace */
function glob(pattern, { max = 200 } = {}) {
  const pat = String(pattern || '').trim();
  if (!pat) return [];
  const patterns = expandBraces(pat);
  const out = new Set();
  const walk = (d, depth) => {
    if (out.size >= max || depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= max) return;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      const r = rel(full);
      for (const p of patterns) {
        if (globToRegex(p).test(r)) out.add(r);
      }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(getWorkDir(), 0);
  return [...out].sort();
}

function readFile(p) {
  const abs = safeResolve(p);
  const st = stat(abs);
  if (!st || !st.isFile()) throw Object.assign(new Error(`not a file: ${p}`), { code: 'ENOENT' });
  if (st.size > MAX_READ_BYTES) throw new Error(`file too large to read (${st.size} bytes; limit ${MAX_READ_BYTES})`);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) throw new Error(`binary file: ${p}`);
  return { path: rel(abs), content: buf.toString('utf8'), size: st.size };
}

function writeFile(p, content, { mkdir = true } = {}) {
  const abs = safeResolve(p);
  const text = String(content == null ? '' : content);
  if (mkdir) fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return { path: rel(abs), bytes: Buffer.byteLength(text) };
}

function deleteFile(p) {
  const abs = safeResolve(p);
  const st = stat(abs);
  if (!st) throw Object.assign(new Error(`not found: ${p}`), { code: 'ENOENT' });
  if (st.isDirectory()) throw new Error(`is a directory: ${p} (delete_file refuses directories)`);
  fs.unlinkSync(abs);
  return { path: rel(abs) };
}

/** exact-string replace; throws with the occurrence count when the needle is ambiguous */
function editFile(p, oldString, newString, { replaceAll = false } = {}) {
  const abs = safeResolve(p);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { throw Object.assign(new Error(`not a file: ${p}`), { code: 'ENOENT' }); }
  const oldS = String(oldString == null ? '' : oldString);
  const newS = String(newString == null ? '' : newString);
  if (!oldS) throw new Error('oldString is empty');
  if (oldS === newS) throw new Error('oldString and newString are identical');
  const count = text.split(oldS).length - 1;
  if (count === 0) throw new Error(`oldString not found in ${p}`);
  if (count > 1 && !replaceAll) throw new Error(`oldString occurs ${count} times in ${p} — provide more surrounding context or set replace_all`);
  const next = replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  fs.writeFileSync(abs, next, 'utf8');
  return { path: rel(abs), replacements: replaceAll ? count : 1 };
}

/** grep the workspace; returns [{path, line, text}] */
function grep(pattern, opts = {}) {
  const max = opts.max || 100;
  const include = opts.include || null;
  let rx;
  try { rx = new RegExp(pattern, 'i'); } catch (e) { throw new Error(`invalid regex`); }
  const includeRx = include ? globToRegex(include.replace(/\*\*/g, '*')) : null;
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= max || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      const r = rel(full);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (includeRx) { const bn=path.basename(r); let ok = includeRx.test(bn) || includeRx.test(r); if(!ok && include.startsWith('*.')) ok = bn.endsWith(include.slice(1)); if(!ok) continue; }
      const st = stat(full);
      if (!st || st.size > 1024 * 1024) continue;
      let text;
      try {
        const buf = fs.readFileSync(full);
        if (isBinary(buf)) continue;
        text = buf.toString('utf8');
      } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (out.length >= max) return;
        if (rx.test(lines[i])) out.push({ path: r, line: i + 1, text: lines[i].slice(0, 400) });
      }
    }
  };
  walk(getWorkDir(), 0);
  return out;
}

/** save oversized tool output to .ytstudio/tool-output/ and return the virtual path */
function stashToolOutput(text) {
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`;
  const abs = path.join(studioDir(), 'tool-output', name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(text), 'utf8');
  return VIRTUAL_PREFIX + '/tool-output/' + name;
}

function exists(p) {
  try { return stat(safeResolve(p)) != null; } catch { return false; }
}

module.exports = {
  safeResolve, rel, listDir, glob, readFile, writeFile, deleteFile, editFile, grep,
  stashToolOutput, exists, MAX_READ_BYTES,
};
