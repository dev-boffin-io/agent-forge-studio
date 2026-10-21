'use strict';

// Commands — slash commands: "/script title: X" expands into a user message. Built-ins map to
// skills (DRY: the command is a thin pointer, the skill carries the procedure). Custom commands
// are .md files in .ytstudio/commands/ or workspace commands/; "$ARGUMENTS" is substituted.

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT, studioDir, getWorkDir } = require('./config');
const log = require('./log');

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

function listCommands() {
  const out = {};
  for (const [name, tmpl] of Object.entries(BUILTIN)) out[name] = { name, template: tmpl, builtin: true };
  for (const dir of commandDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.md$/, '').toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      try {
        const body = fs.readFileSync(path.join(dir, f), 'utf8').trim();
        out[name] = { name, template: body, builtin: false };
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
  const text = cmd.template.includes('$ARGUMENTS')
    ? cmd.template.split('$ARGUMENTS').join(args)
    : (args ? cmd.template + '\n\n' + args : cmd.template);
  return { name, text };
}

module.exports = { BUILTIN, listCommands, expand };
