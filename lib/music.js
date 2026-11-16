'use strict';

// music — discover local background-music files and choose one deterministically. No external
// service or API key: drop audio files in <workspace>/music (or cfg.music.dir) and the renderer
// loops/ducks them under the voiceover.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const DEFAULT_DIRS = ['music', path.join('assets', 'music')];
const DEFAULT_VOLUME = 0.12;

function walk(dir, out, depth = 0) {
  if (depth > 5 || out.length >= 500) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out, depth + 1);
    else if (ent.isFile() && AUDIO_EXT.test(ent.name)) {
      try {
        const st = fs.statSync(full);
        out.push({ path: full, bytes: st.size, name: ent.name });
      } catch { /* vanished */ }
    }
    if (out.length >= 500) return;
  }
}

function musicDirs(cfg = {}) {
  const m = cfg.music || {};
  if (Array.isArray(m.dirs) && m.dirs.length) return m.dirs.map(String);
  if (typeof m.dir === 'string' && m.dir.trim()) return [m.dir.trim()];
  return DEFAULT_DIRS;
}

/** List audio files under the configured music directories. Paths are workspace-relative. */
function listMusic({ workDir, cfg = {} } = {}) {
  const base = workDir || process.cwd();
  const files = [];
  const seen = new Set();
  for (const relDir of musicDirs(cfg)) {
    const dir = path.isAbsolute(relDir) ? relDir : path.join(base, relDir);
    const found = [];
    walk(dir, found);
    for (const f of found) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push({ ...f, file: path.relative(base, f.path) });
    }
  }
  return { files, dirs: musicDirs(cfg) };
}

function scoreName(name, mood) {
  const hay = String(name || '').toLowerCase();
  const words = String(mood || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let score = 0;
  for (const w of words) if (hay.includes(w)) score += 10;
  if (/ambient|cinematic|documentary|inspiring|calm|soft/.test(hay)) score += 1;
  return score;
}

/** Deterministically choose a track, preferring names that match the requested mood. */
function pickMusic(files, { mood = '', seed = '' } = {}) {
  const list = Array.isArray(files) ? files.slice() : [];
  if (!list.length) return null;
  const ranked = list.map((f) => ({
    f,
    score: scoreName(f.name || f.file, mood),
    order: crypto.createHash('sha1').update(`${seed}\0${f.file || f.name || ''}`).digest('hex'),
  })).sort((a, b) => (b.score - a.score) || a.order.localeCompare(b.order));
  return ranked[0].f;
}

/**
 * Resolve the track for a render. Explicit `file` wins; otherwise pick from the music folder.
 * Returns {file, absolute, volume, duck, fadeSeconds, source} or null.
 */
function resolveMusic({ workDir, cfg = {}, file = '', mood = '', seed = '' } = {}) {
  const m = cfg.music || {};
  const base = workDir || process.cwd();
  const explicit = file || m.file || m.path || '';
  let chosen = null;
  if (explicit) {
    const abs = path.isAbsolute(explicit) ? explicit : path.join(base, explicit);
    if (fs.existsSync(abs) && AUDIO_EXT.test(abs)) chosen = { file: path.relative(base, abs), path: abs, name: path.basename(abs) };
  }
  if (!chosen) {
    const listed = listMusic({ workDir: base, cfg });
    chosen = pickMusic(listed.files, { mood, seed });
  }
  if (!chosen) return null;
  return {
    file: chosen.file,
    absolute: path.isAbsolute(chosen.path) ? chosen.path : path.join(base, chosen.path),
    volume: Number(m.volume) > 0 ? Math.min(Number(m.volume), 1) : DEFAULT_VOLUME,
    duck: m.duck !== false,
    fadeSeconds: Number(m.fadeSeconds) >= 0 ? Number(m.fadeSeconds) : 2,
    source: explicit ? 'explicit' : 'folder',
  };
}

module.exports = { AUDIO_EXT, DEFAULT_DIRS, listMusic, pickMusic, resolveMusic };
