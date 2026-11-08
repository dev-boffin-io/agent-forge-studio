'use strict';

const log = require('./log');

// Skills: folders containing SKILL.md with frontmatter { name, description }.
// Scanned in: <dir>/.studio/skills (and legacy .ytstudio), <dir>/.claude/skills, <dir>/.agents/skills,
// <dir>/skills, <app>/skills, ~/.config/youtube-studio/skills, ~/.claude/skills, ~/.agents/skills,
// plus config.skills.paths. The model sees name+description and loads the body on demand with `skill`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ROOT, GLOBAL_DIR, getWorkDir, studioDir, loadConfig } = require('./config');

const cache = new Map(); // id -> skill

/** Flat YAML-ish frontmatter parser with block scalar support (| and >). */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: String(raw).trim() };
  const meta = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):([ \t]*)(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const inline = kv[3].trim();
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
      meta[key] = inline[0] === '|' ? block.join('\n') : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    meta[key] = inline.replace(/^["']|["']$/g, '');
  }
  return { meta, body: (m[2] || '').trim() };
}

function scanDir(root, out) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory() || e.isSymbolicLink()) {
      const file = path.join(full, 'SKILL.md');
      if (fs.existsSync(file)) {
        try {
          const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
          if (typeof meta.name !== 'string' || !meta.name) continue;
          const name = meta.name;
          let trusted = true;
          try {
            const source = JSON.parse(fs.readFileSync(path.join(full, '.source.json'), 'utf8'));
            if (source.trusted === false) trusted = false;
          } catch { /* built-in or local skill */ }
          out[name] = {
            id: e.name, name, description: typeof meta.description === 'string' ? meta.description : '',
            location: file, source: file, base: full, content: body, body, trusted,
          };
        } catch (err) { log.warn('skills', `skipping unreadable skill ${file}`, err); }
      } else if (e.isDirectory()) scanDir(full, out); // nested groups
    }
  }
}

function skillDirs() {
  const dir = getWorkDir();
  const home = os.homedir();
  const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
  const dirs = [];
  if (APP_ROOT) dirs.push(path.join(APP_ROOT, 'skills'));
  for (const p of (cfg.skills && cfg.skills.paths) || []) {
    try { dirs.push(p.startsWith('~/') ? path.join(home, p.slice(2)) : (path.isAbsolute(p) ? p : path.join(dir, p))); } catch { /* ignore */ }
  }
  dirs.push(
    path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(GLOBAL_DIR, 'skills'),
    path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills'),
    path.join(studioDir(), 'skills'), path.join(dir, 'skills'),
  );
  return dirs;
}

function loadSkills(config) {
  const out = {};
  for (const r of skillDirs()) scanDir(r, out);
  return out;
}

function listFiles(base, limit = 10) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3 || files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name !== 'SKILL.md') files.push(path.relative(base, f));
    }
  };
  walk(base, 0);
  return files;
}

/** Load by directory id (agent-forge style), cached. */
function loadSkill(id) {
  const clean = String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  if (cache.has(clean)) return cache.get(clean);
  for (const dir of skillDirs()) {
    const file = path.join(dir, clean, 'SKILL.md');
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      let trusted = true;
      try {
        const source = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.source.json'), 'utf8'));
        if (source.trusted === false) trusted = false;
      } catch { /* built-in or local skill */ }
      const skill = { id: clean, name: meta.name || clean, description: meta.description || '', body, content: body, source: file, location: file, base: path.dirname(file), trusted };
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

/** Load by skill name for the model (`skill` tool); returns a <skill_content> block. */
function load(name, config) {
  const all = loadSkills(config);
  const s = all[name] || Object.values(all).find((x) => x.id === name || x.name === name);
  if (!s) throw new Error(`Skill "${name}" not found. Available skills: ${Object.keys(all).join(', ') || 'none'}`);
  const warn = s.trusted === false
    ? ['> UNTRUSTED SKILL: installed from an external repo. Its scripts may be dangerous; every bundled script run will ask for confirmation.', '']
    : [];
  return [
    `<skill_content name="${s.name}">`,
    `# Skill: ${s.name}`, '', ...warn, s.content.trim(), '',
    `Base directory for this skill: ${s.base}`,
    'Relative paths in this skill (e.g. scripts/, reference/) are relative to this base directory (use bash/read_file with the full path).',
    'Note: the file list is sampled.', '',
    '<skill_files>', ...listFiles(s.base).map((f) => `<file>${f}</file>`), '</skill_files>',
    '</skill_content>',
  ].join('\n');
}

/** Prompt section listing the skills available to the model. */
function promptSection(config) {
  const all = Object.values(loadSkills(config));
  if (!all.length) return '';
  return 'Skills provide specialised instructions for specific tasks. When a task matches one, call the "skill" tool with its name BEFORE starting. Available skills:\n' +
    all.map((s) => `- ${s.name}: ${s.description || '(no description)'}${s.trusted === false ? ' (UNTRUSTED)' : ''}`).join('\n');
}

function resolveSkillCandidate(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw.split('/').includes('..')) return '';
  for (const prefix of ['.studio', '.ytstudio']) {
    if (raw.startsWith(prefix + '/')) return path.join(studioDir(), raw.slice(prefix.length + 1));
    if (raw === prefix) return studioDir();
  }
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
  if (/\.(?:studio|ytstudio)\/skills\//.test(cmd)) return true;
  for (const dir of skillDirs()) {
    const abs = path.resolve(dir);
    if (cmd.includes(abs + path.sep) || cmd.includes(abs + '/')) return true;
  }
  return /(^|[\s"'`=(])(?:\.\/)?skills\/[^\s"'`)]+\.(?:sh|py|js|ps1)\b/i.test(cmd);
}

function clearCache() { cache.clear(); }

module.exports = {
  loadSkills, load, loadSkill, listSkills, promptSection, parseFrontmatter, clearCache,
  untrustedSkillForPath, commandUsesSkillScript, skillDirs,
};
