'use strict';

// Skills — SKILL.md files with a YAML-ish frontmatter (name, description) + body. Discovery:
// built-in skills/ folder in the app, plus cfg.skills.paths, plus .ytstudio/skills/, plus
// workspace skills/. The agent loads one with the `skill` tool; slash commands expand to a
// "load skill X and do Y" user message.

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT, studioDir, getWorkDir, loadConfig } = require('./config');
const log = require('./log');

const cache = new Map(); // id -> skill

function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: (m[2] || '').trim() };
}

function skillDirs() {
  const dirs = [];
  if (APP_ROOT) dirs.push(path.join(APP_ROOT, 'skills'));
  const cfg = loadConfig();
  for (const p of (cfg.skills && cfg.skills.paths) || []) {
    try { dirs.push(path.isAbsolute(p) ? p : path.join(getWorkDir(), p)); } catch { /* ignore */ }
  }
  dirs.push(path.join(studioDir(), 'skills'));
  dirs.push(path.join(getWorkDir(), 'skills'));
  return dirs;
}

function loadSkill(id) {
  const clean = String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  if (cache.has(clean)) return cache.get(clean);
  for (const dir of skillDirs()) {
    const file = path.join(dir, clean, 'SKILL.md');
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const skill = { id: clean, name: meta.name || clean, description: meta.description || '', body, source: file };
      cache.set(clean, skill);
      return skill;
    } catch { /* try next dir */ }
  }
  return null;
}

function listSkills() {
  const seen = new Map();
  for (const dir of skillDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const s = loadSkill(e.name);
      if (s) seen.set(e.name, { id: s.id, name: s.name, description: s.description });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function clearCache() { cache.clear(); }

module.exports = { loadSkill, listSkills, parseFrontmatter, clearCache };
