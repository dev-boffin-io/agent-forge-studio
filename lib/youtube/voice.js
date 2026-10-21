'use strict';

// voice.md — the channel's writing/performance voice, read by every voice-enabled agent and by the
// skills. Lives at the root of the channel workspace. The read path caps at MAX_READ so a huge
// file cannot blow the system prompt; the write path caps at MAX_CREATE so it stays a readable
// brief rather than a dump.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'voice.md';
const MAX_READ = 8000;   // injected into the agent's system prompt
const MAX_CREATE = 12000; // what the agent may write back

function voicePath(workDir) {
  return path.join(workDir, FILE);
}

/** Read voice.md from a workspace; returns '' when absent. Truncated to MAX_READ. */
function read(workDir) {
  try {
    const t = fs.readFileSync(voicePath(workDir), 'utf8');
    return t.length > MAX_READ ? t.slice(0, MAX_READ) + '\n\n[voice.md truncated for the prompt]' : t;
  } catch { return ''; }
}

/** Write voice.md (capped at MAX_CREATE). Returns {file, chars, truncated}. */
function write(workDir, text) {
  const t = String(text == null ? '' : text);
  const capped = t.length > MAX_CREATE ? t.slice(0, MAX_CREATE) : t;
  const file = voicePath(workDir);
  fs.writeFileSync(file, capped.endsWith('\n') ? capped : capped + '\n', 'utf8');
  return { file: FILE, chars: capped.length, truncated: t.length > MAX_CREATE };
}

function exists(workDir) {
  return fs.existsSync(voicePath(workDir));
}

module.exports = { read, write, exists, FILE, MAX_READ, MAX_CREATE };
