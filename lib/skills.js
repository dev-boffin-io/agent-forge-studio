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
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):([ \t]*)(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const inline = kv[3].trim();
    // Block scalar (YAML folded ">" or literal "|"): consume the indented block that follows.
    if (/^[|>][-+]?$/.test(inline)) {
      const block = []; let indent = null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') { block.push(''); continue; }
        const lead = line.length - line.trimStart().length;
        if (indent === null) indent = lead;
        if (lead < indent) break;
        block.push(line.slice(indent));
        i = j;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      meta[key] = (inline[0] === '|' ? block.join('\n') : block.join(' ').replace(/\s+/g, ' ').trim());
      continue;
    }
    meta[key] = inline;
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
      let trusted = true;
      try {
        const source = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.source.json'), 'utf8'));
        if (source.trusted === false) trusted = false;
      } catch { /* built-in or local skill */ }
      const skill = { id: clean, name: meta.name || clean, description: meta.description || '', body, source: file, trusted };
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
      if (s) seen.set(e.name, { id: s.id, name: s.name, description: s.description, trusted: s.trusted });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}


/** Resolve a tool path to an absolute path, including the .ytstudio/ virtual prefix. */
function resolveSkillCandidate(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw.split('/').includes('..')) return '';
  if (raw.startsWith('.ytstudio/')) return path.join(studioDir(), raw.slice('.ytstudio/'.length));
  if (raw === '.ytstudio') return studioDir();
  if (path.isAbsolute(raw)) return raw;
  return path.join(getWorkDir(), raw);
}

/** The id of an untrusted installed skill containing this path, or null. */
function untrustedSkillForPath(p) {
  const root = path.join(studioDir(), 'skills');
  const abs = resolveSkillCandidate(p);
  if (!abs) return null;
  const rel = path.relative(root, path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const id = rel.split(path.sep)[0];
  const s = loadSkill(id);
  return s && s.trusted === false ? id : null;
}

/** True when a shell command appears to execute a script bundled inside a skill folder. */
function commandUsesSkillScript(command) {
  const cmd = String(command || '');
  if (!/\.(?:sh|py|js|ps1)\b/i.test(cmd)) return false;
  if (cmd.includes('.ytstudio/skills/')) return true;
  for (const dir of skillDirs()) {
    const abs = path.resolve(dir);
    if (cmd.includes(abs + path.sep) || cmd.includes(abs + '/')) return true;
  }
  return /(^|[\s"'`=(])(?:\.\/)?skills\/[^\s"'`)]+\.(?:sh|py|js|ps1)\b/i.test(cmd);
}

function clearCache() { cache.clear(); }

module.exports = { loadSkill, listSkills, parseFrontmatter, clearCache, untrustedSkillForPath, commandUsesSkillScript, skillDirs };
