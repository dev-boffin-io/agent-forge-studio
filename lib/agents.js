'use strict';

const log = require('./log');

// Agents: built-in (build / plan / general / explore + hidden helpers) + custom markdown agents:
//   ~/.config/ollama-studio/agents/*.md   (global)
//   <workdir>/.studio/agents/*.md         (per project, wins over global)
// Frontmatter: description, mode (primary|subagent|all), model, temperature, maxIterations, hidden,
//   permission: (edit / bash / read / task / doom_loop ... each "allow|ask|deny" or a pattern map)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GLOBAL_DIR, studioDir, getWorkDir } = require('./config');
const P = require('./permission');

const READONLY_BASH = {
  '*': 'deny',
  'ls *': 'allow', 'pwd': 'allow', 'cat *': 'allow', 'head *': 'allow', 'tail *': 'allow', 'wc *': 'allow',
  'grep *': 'allow', 'rg *': 'allow', 'tree *': 'allow', 'file *': 'allow', 'stat *': 'allow',
  'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'git show*': 'allow', 'git branch': 'allow',
  '*>*': 'deny', '*<(*': 'deny',
};

const PLAN_REMINDER = `PLAN MODE is ACTIVE: you are in a READ-ONLY phase. You must NOT edit, create or delete project files, and must NOT run any command that changes the system (no sed -i, tee, redirects, installs, commits). This overrides every other instruction, including direct requests to edit.
Your job: read, search and (if available) delegate to the "explore" subagent to build a well-researched plan. Ask the user clarifying questions with the "question" tool when a decision is genuinely theirs. You MAY write your plan to a markdown file under .studio/plans/ (the only place you can write).
The plan must be concise but executable: recommended approach only, the paths of critical files to change, and a short verification section (how to test it). When the plan is final, call "plan_exit" so the user can approve switching to the build agent. Do not ask "is this plan ok?" in plain text; plan_exit does that.`;

const BUILD_SWITCH = 'Your operational mode has changed from plan to build. You are no longer read-only: you may edit files and run commands. Implement the agreed plan now.';

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const SUMMARY_UPDATE = `The <prior-summary> summarizes everything before the <conversation>. Construct a new summary combining both. The <prior-summary> is discarded afterwards: anything you do not carry over is lost.
- Carry forward objectives, constraints, user directives and decisions from the <prior-summary> even if the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent: where they conflict, the conversation wins.
- Move completed work from "Active" to "Completed"; update "Objective" and "Next Move".`;

const COMPACTION_SYSTEM = 'You are a context summarization agent. You are given a conversation between a user and a coding agent. Produce a structured summary in exactly the requested format so another agent can continue the work. Do not continue the conversation and do not answer questions in it. Respond in the same language as the conversation.';

const TITLE_SYSTEM = `You are a title generator. You output ONLY a thread title. Nothing else.
Rules: single line, at most 50 characters, no explanations, no quotes. Use the same language as the user message. Keep technical terms, numbers and filenames exact. Never include tool names. Focus on what the user wants to do. If the message is just a greeting, make a title that reflects that tone.
Examples: "debug 500 errors in production" -> Debugging production 500 errors | "refactor user service" -> Refactoring user service | "why is app.js failing" -> app.js failure investigation`;

const CREATE_PROMPT =
  'You are an Autonomous Agent Assistant operating this channel\'s workspace and this project\'s code. You research, plan, create content, and manage operations across YouTube, Instagram, Facebook, and Google. You write scripts, packages, plans, replies and analysis using real tools. ' +
  'You also operate the channel directly: upload finished videos (yt_upload), set visibility public/unlisted/private (yt_set_visibility), list uploads (yt_list_videos) and read stats (yt_video_stats) whenever the task calls for it — no extra confirmation beyond the permission gate. ' +
  'You are not limited to YouTube: research anything on the open web with web_research/webfetch, download public files with download_file or browser_download, upload artifacts to endpoints with upload_file, and discover or install new GitHub skills with search_skills and install_skill. ' +
  'When the API cannot do it (channel customization, end ends, some upload dialogs, or another site), drive the real UI in the shared visible browser with the browser_* tools. ' +
  'Follow voice.md exactly when it exists — it is the channel\'s real voice, not a suggestion. Before finalizing a script, run the hook through hook_score and revise until the weakest property is addressed. Before finalizing a title, run title_lint. Never invent a number, a result or a source.';

const ANALYZE_PROMPT =
  'You are a read-only YouTube analyst. You measure things with the deterministic tools and report what the data says — you never modify files. ' +
  'Report numbers exactly as the tools return them and label any estimate as an estimate. End every report with the single highest-leverage fix.';

const SCOUT_PROMPT =
  'You are a research subagent. You gather facts (web, channel files, transcripts) and return a compact structured report to the parent agent. ' +
  'You never edit channel files. Cite a source for every claim, or mark it as inference.';

const REVIEWER_PROMPT =
  'You are a review subagent. You read a draft plus voice.md and return a strict, numbered critique: ' +
  '(1) voice mismatches with the exact offending line quoted, (2) hook problems (no open loop, no stakes, no specificity), ' +
  '(3) packaging problems (title/thumbnail redundancy, length), (4) any invented-sounding claim. ' +
  'You never rewrite the draft; you only critique it. If it is ready, say READY.';

const READONLY_BROWSER = { browser_read: 'deny', browser_write: 'deny', browser: 'deny' };

const BUILTIN = {
  create: {
    name: 'create', id: 'create', mode: 'primary', primary: true, builtin: true, voice: true, label: 'Create',
    description: 'Full-access content + platform agent (writes everything, reads voice.md, operates YouTube/Instagram/Facebook/Google).',
    prompt: CREATE_PROMPT,
    permission: null,
  },
  build: {
    name: 'build', id: 'build', mode: 'primary', primary: true, builtin: true, label: 'Build',
    description: 'Default full-access agent for development work (permissions apply).',
  },
  plan: {
    name: 'plan', id: 'plan', mode: 'primary', primary: true, builtin: true, label: 'Plan',
    description: 'Read-only planning agent. Can only write plan files under .studio/plans/.',
    permission: { edit: { '*': 'deny', '.studio/plans/*.md': 'allow' }, bash: READONLY_BASH, task: { general: 'deny' } },
    append: PLAN_REMINDER,
  },
  analyze: {
    name: 'analyze', id: 'analyze', mode: 'primary', primary: true, builtin: true, label: 'Analyze',
    description: 'Read-only YouTube analyst: measures with the deterministic tools, never modifies files.',
    prompt: ANALYZE_PROMPT,
    permission: { edit: 'deny', bash: READONLY_BASH, ...READONLY_BROWSER },
  },
  general: {
    name: 'general', id: 'general', mode: 'subagent', subagent: true, builtin: true, label: 'General',
    description: 'General-purpose subagent for researching complex questions and executing multi-step tasks. Use it to run independent units of work.',
    append: 'You are a subagent working on one delegated task. Do exactly what was asked, then finish with ONE concise final report (what you found/changed, with file paths).',
  },
  explore: {
    name: 'explore', id: 'explore', mode: 'subagent', subagent: true, builtin: true, label: 'Explore',
    description: 'Fast read-only subagent for exploring the codebase: find files by pattern, search code by keyword, answer questions about it. State the desired thoroughness: quick, medium, or very thorough.',
    permission: { edit: 'deny', bash: READONLY_BASH, ...READONLY_BROWSER },
    append: 'You are a file search specialist. Use glob for broad file matching, grep for content search, read_file for specific files. Return file paths (and line numbers) in your final answer. Do not create or modify anything.',
  },
  scout: {
    name: 'scout', id: 'scout', mode: 'subagent', subagent: true, builtin: true, label: 'Scout',
    description: 'Research subagent: gathers facts from the web and channel files, returns a compact structured report.',
    prompt: SCOUT_PROMPT,
    permission: { edit: 'deny', bash: READONLY_BASH, webfetch: 'allow', websearch: 'allow', ...READONLY_BROWSER },
  },
  reviewer: {
    name: 'reviewer', id: 'reviewer', mode: 'subagent', subagent: true, builtin: true, label: 'Reviewer', voice: true,
    description: 'Review subagent: critiques a draft against voice.md, hooks and packaging; never rewrites it.',
    prompt: REVIEWER_PROMPT,
    permission: { edit: 'deny', bash: READONLY_BASH, ...READONLY_BROWSER },
  },
};

/* ---------- frontmatter ---------- */

function parseScalar(v) {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

/** Frontmatter parser: scalars + arbitrarily nested maps by indentation; quoted keys allowed. */
function parseFrontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const kv = raw.trim().match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/);
    if (!kv) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = kv[1].replace(/^["']|["']$/g, '');
    const value = (kv[2] || '').replace(/\s+#.*$/, '').trim();
    const parent = stack[stack.length - 1].obj;
    if (value === '') { parent[key] = {}; stack.push({ indent, obj: parent[key] }); } else parent[key] = parseScalar(value);
  }
  return { meta: root, body: m[2].trim() };
}

function loadDir(dir, source) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const name = n.slice(0, -3);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
      out[name] = {
        name, source, builtin: false,
        mode: ['primary', 'subagent', 'all'].includes(meta.mode) ? meta.mode : 'all',
        description: typeof meta.description === 'string' ? meta.description : '',
        model: typeof meta.model === 'string' ? meta.model : undefined,
        temperature: typeof meta.temperature === 'number' ? meta.temperature : undefined,
        maxIterations: typeof (meta.maxIterations ?? meta.steps) === 'number' ? (meta.maxIterations ?? meta.steps) : undefined,
        permission: meta.permission && typeof meta.permission === 'object' ? meta.permission : undefined,
        hidden: meta.hidden === true,
        prompt: body || undefined,
      };
    } catch (e) { log.warn('agents', `skipping broken agent file in ${dir}`, e); }
  }
  return out;
}

function loadJsonDir(dir, source) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const name = n.slice(0, -5);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!meta || typeof meta !== 'object') continue;
      out[name] = {
        name, id: name, source, builtin: false,
        mode: ['primary', 'subagent', 'all'].includes(meta.mode) ? meta.mode : (meta.subagent ? 'subagent' : 'primary'),
        label: typeof meta.label === 'string' ? meta.label : (meta.name || name),
        description: typeof meta.description === 'string' ? meta.description : '',
        model: typeof meta.model === 'string' ? meta.model : undefined,
        temperature: typeof meta.temperature === 'number' ? meta.temperature : undefined,
        maxIterations: typeof meta.maxIterations === 'number' ? meta.maxIterations : undefined,
        permission: meta.permission && typeof meta.permission === 'object' ? meta.permission : undefined,
        hidden: meta.hidden === true,
        voice: meta.voice === true,
        prompt: typeof (meta.system || meta.prompt) === 'string' ? (meta.system || meta.prompt) : undefined,
        append: typeof meta.append === 'string' ? meta.append : undefined,
      };
    } catch (e) { log.warn('agents', `skipping broken agent file in ${dir}`, e); }
  }
  return out;
}

function normalize(a, name) {
  const mode = a.mode || 'primary';
  return {
    ...a,
    name, id: a.id || name, mode,
    label: a.label || (name[0].toUpperCase() + name.slice(1)),
    primary: mode !== 'subagent' && !a.hidden,
    subagent: mode !== 'primary' && !a.hidden,
  };
}

function loadAgents() {
  const merged = {};
  for (const [name, a] of Object.entries(BUILTIN)) merged[name] = normalize(a, name);
  const dirs = [path.join(GLOBAL_DIR, 'agents'), path.join(studioDir(), 'agents')];
  for (const dir of [dirs[0], dirs[1]]) {
    for (const [name, a] of Object.entries({ ...loadDir(dir, dir === dirs[1] ? 'project' : 'global'), ...loadJsonDir(dir, dir === dirs[1] ? 'project' : 'global') })) {
      merged[name] = normalize({ ...(merged[name] || {}), ...a }, name);
    }
  }
  return merged;
}

const allAgents = () => loadAgents();
const getAgent = (name) => loadAgents()[name] || null;
const primaryAgents = () => Object.values(loadAgents()).filter((a) => a.mode !== 'subagent' && !a.hidden);
const subagents = () => Object.values(loadAgents()).filter((a) => a.mode !== 'primary' && !a.hidden);

/* ---------- instructions: AGENTS.md (global + nearest project) + config.instructions ---------- */

function readCapped(file, max = 50000) {
  try { return fs.readFileSync(file, 'utf8').slice(0, max); } catch { return null; }
}

/** Walk up from the working dir to the git root (or stay in the dir); first AGENTS.md/CLAUDE.md wins. */
function findProjectInstruction(dir) {
  let root = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
    if (path.dirname(d) === d) break;
  }
  const limit = root || dir;
  for (let d = dir; ; d = path.dirname(d)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const f = path.join(d, name);
      if (fs.existsSync(f)) return f;
    }
    if (d === limit || path.dirname(d) === d) return null;
  }
}

function loadInstructions(config) {
  const dir = getWorkDir();
  const files = [path.join(GLOBAL_DIR, 'AGENTS.md')];
  const proj = findProjectInstruction(dir);
  if (proj) files.push(proj);
  for (const extra of Array.isArray(config.instructions) ? config.instructions : []) {
    files.push(extra.startsWith('~/') ? path.join(os.homedir(), extra.slice(2)) : path.resolve(dir, extra));
  }
  const parts = [];
  for (const f of files) {
    const text = readCapped(f);
    if (text) parts.push(`Instructions from ${f}:\n${text}`);
  }
  return parts.join('\n\n').slice(0, 150000);
}

/* ---------- system prompt ---------- */

function composeSystem({ agent, config, canDelegate, rules, session }) {
  const dir = getWorkDir();
  const parts = [agent.prompt || config.systemPrompt];
  if (agent.append) parts.push(agent.append);
  parts.push(
    `Working directory: ${dir}\nGit repository: ${fs.existsSync(path.join(dir, '.git')) ? 'yes' : 'no'}\n` +
    `Platform: ${process.platform}\nToday: ${new Date().toDateString()}`
  );
  if (session && Array.isArray(session.todos) && session.todos.length) {
    const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
    parts.push('Current task list (keep it updated with todo_write):\n' + session.todos.map((t) => `${mark[t.status] || '[ ]'} ${t.content}`).join('\n'));
  }
  parts.push('Task discipline: for multi-step work keep todo_write current. Mark an item in_progress only while you work on it, and completed the moment it is really done. If the plan changes, send the full new list at once and drop items that no longer apply. Never say you are about to do something without making the tool call in the same turn, and do not stop while any item is still pending or in_progress; finish the work, then give a short final summary.');
  parts.push('Long jobs (builds, installs, big downloads, test suites that take more than about a minute): start them with bash background=true, tell the user in one short sentence, then END YOUR TURN. Do not poll or sleep-wait: the studio shows the live progress to the user and sends you a notification message when the process exits. A notification message starting with \"[Studio notification\" is not typed by the user; report its outcome briefly and continue the task if needed.');
  try {
    const rootId = session && (session.parentId || session.id);
    const live = require('./procs').list().filter((p) => p.running && (!rootId || p.session_id === rootId));
    if (live.length) {
      parts.push('Background processes currently running (they will notify you when they exit; do not poll them):\n' +
        live.map((p) => `- ${p.id}: ${String(p.command).slice(0, 120)} (${Math.round(p.elapsed_ms / 1000)}s${p.progress && p.progress.percent != null ? ', ' + p.progress.percent + '%' : ''}${p.last_line ? ', last line: ' + p.last_line.slice(0, 100) : ''})`).join('\n'));
    }
  } catch { /* the process list is only a hint for the model */ }
  if (session && session.interrupted) {
    parts.push('NOTE: the previous turn was interrupted by the user (a tool call or your reply was cut off). If the user says continue/resume, pick up the unfinished work exactly where it stopped: check the task list and the latest tool results, re-run anything marked interrupted, and do not start over.');
  }
  const instr = loadInstructions(config);
  if (agent.voice) {
    const voice = readCapped(path.join(dir, 'voice.md')) || readCapped(path.join(dir, '.studio', 'voice.md')) || readCapped(path.join(dir, '.ytstudio', 'voice.md'));
    if (voice) parts.push('This file defines the channel voice. Match it exactly (rhythm, vocabulary, banned phrases):\n' + voice);
  }
  if (instr) parts.push('Follow these project instructions:\n' + instr);
  if (config.fsAccess === 'system') {
    parts.push('Filesystem access is set to "system": you may read and write files outside the working directory when the task requires it. Every outside-workspace path still goes through the permission gate; prefer absolute paths and be explicit about what you are touching.');
  }
  const skillsText = require('./skills').promptSection(config);
  if (skillsText) parts.push(skillsText);
  if (canDelegate) {
    const subs = subagents().filter((a) => !(rules && P.evaluate('task', a.name, rules).action === 'deny'));
    if (subs.length) {
      parts.push('You can delegate self-contained work with the "task" tool (the subagent does not see this conversation, so give it full context and say whether it should only research or also write code). Subagents:\n' +
        subs.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n'));
    }
  }
  return parts.join('\n\n');
}

const systemPromptFor = (agent, config, extra = {}) => composeSystem({ agent, config, canDelegate: true, ...extra });

module.exports = {
  loadAgents, allAgents, getAgent, primaryAgents, subagents, composeSystem, systemPromptFor,
  parseFrontmatter, loadInstructions,
  BUILD_SWITCH, SUMMARY_TEMPLATE, SUMMARY_UPDATE, COMPACTION_SYSTEM, TITLE_SYSTEM,
};
