'use strict';

// Commands — slash commands: "/script title: X" expands into a user message. Built-ins map to
// skills (DRY: the command is a thin pointer, the skill carries the procedure). Custom commands
// are .md files in .ytstudio/commands/ or workspace commands/; "$ARGUMENTS" is substituted.

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT, studioDir, getWorkDir } = require('./config');
const log = require('./log');

const BUILTIN_DESCRIPTIONS = {
  script: 'draft a video script', package: 'draft title and thumbnail concept', edit: 'create an edit decision list',
  comment: 'draft a comment reply', plan: 'build a content plan', viral: 'analyze outlier videos',
  retention: 'analyze a retention export', shorts: 'cut a Shorts plan', seo: 'draft video metadata',
  chapters: 'draft chapters from a transcript', audit: 'audit the channel', voice: 'fill in or update voice.md',
  init: 'create/update CHANNEL.md and voice.md for this directory',
  thumbnail: 'generate a thumbnail', narrate: 'synthesize a voiceover', footage: 'find and download stock footage', render: 'render a video',
};

const BUILTIN = {
  script: 'Load skill yt-script and write the script for: $ARGUMENTS',
  package: 'Load skill yt-package and produce the title + thumbnail concept for: $ARGUMENTS',
  edit: 'Load skill yt-edit and produce the edit decision list for: $ARGUMENTS',
  comment: 'Load skill yt-comment and draft the reply for: $ARGUMENTS',
  plan: 'Load skill yt-plan and build the plan for: $ARGUMENTS',
  viral: 'Load skill yt-viral and analyze outliers for: $ARGUMENTS',
  retention: 'Load skill yt-retention and analyze the retention export for: $ARGUMENTS',
  shorts: 'Load skill yt-shorts and cut the Shorts plan for: $ARGUMENTS',
  seo: 'Load skill yt-seo and produce the metadata for: $ARGUMENTS',
  chapters: 'Load skill yt-chapters and draft the chapters for: $ARGUMENTS',
  audit: 'Load skill yt-audit and audit the channel for: $ARGUMENTS',
  voice: 'Help me fill in or update voice.md for: $ARGUMENTS',
  init: 'Read the workspace and draft CHANNEL.md (audience, voice, formats, publishing rhythm) plus a starter voice.md for: $ARGUMENTS',
  // ---- standalone media tasks (each calls one tool directly — no full pipeline needed) ----
  thumbnail: 'Call the generate_thumbnail tool to create a 1280x720 PNG thumbnail for: $ARGUMENTS. Report the saved file path.',
  narrate: 'Call the tts_synth tool to synthesize a voiceover for this text: $ARGUMENTS. Report the saved .mp3 path and duration.',
  footage: 'Call the find_stock_footage tool to search and download stock clips for: $ARGUMENTS. Report the provider used and the downloaded clip paths.',
  render: 'Call the render_video tool to render an MP4 from the chosen shots and voiceover for: $ARGUMENTS. Report the output path and duration.',
};

function commandDirs() {
  const dirs = [];
  if (APP_ROOT) dirs.push(path.join(APP_ROOT, 'examples', 'commands'));
  dirs.push(path.join(studioDir(), 'commands'));
  dirs.push(path.join(getWorkDir(), 'commands'));
  return dirs;
}

function parseFrontmatter(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m || !m[2]) continue;
    meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const after = raw.slice(end + 4);
  return { meta, body: after.replace(/^\r?\n/, '').trim() };
}

function argsList(raw) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(raw || '')))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

function inlineFiles(text) {
  const cwd = getWorkDir();
  let out = text;
  const re = /(^|\s)@([A-Za-z0-9._/-]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const rel = m[2];
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    try {
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith(cwd + path.sep)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 200 * 1024) continue;
      out += `\n\nContents of ${rel}:\n` + fs.readFileSync(abs, 'utf8');
    } catch { /* missing/unreadable file stays as plain text */ }
  }
  return out;
}

function listCommands() {
  const out = {};
  for (const [name, tmpl] of Object.entries(BUILTIN)) out[name] = { name, template: tmpl, description: BUILTIN_DESCRIPTIONS[name] || '', builtin: true };
  for (const dir of commandDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.md$/, '').toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      try {
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        out[name] = { name, template: parsed.body, description: parsed.meta.description || '', agent: parsed.meta.agent || '', builtin: false };
      } catch (e) { log.debug('commands', `cannot read ${f}`, e); }
    }
  }
  return out;
}

/** expand "/script foo bar" -> full user message */
function expand(line) {
  const m = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(String(line || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  const cmds = listCommands();
  const cmd = cmds[name];
  if (!cmd) return null;
  const parts = argsList(args);
  let text = cmd.template.replace(/\$([1-9])/g, (_, n) => parts[Number(n) - 1] || '');
  text = text.includes('$ARGUMENTS')
    ? text.split('$ARGUMENTS').join(args)
    : (args ? text + '\n\n' + args : text);
  text = inlineFiles(text);
  return { name, command: cmd, text };
}

module.exports = { BUILTIN, listCommands, loadCommands: listCommands, expand, parseFrontmatter };
