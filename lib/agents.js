'use strict';

// Agents — named configurations of model + system prompt + tool policy + voice. Built-ins:
//   create   (primary, default, writes everything, reads voice.md)
//   analyze  (primary, read-only: edit deny, read-only bash allowlist)
//   scout    (subagent, read-only + web research)
//   reviewer (subagent, checks a draft against voice.md + hook/package rules)
// Custom agents live at .ytstudio/agents/*.json and workspace agents/*.json.

const fs = require('node:fs');
const path = require('node:path');
const { studioDir, getWorkDir, APP_ROOT } = require('./config');
const log = require('./log');

const BUILTINS = {
  create: {
    id: 'create', primary: true, voice: true,
    label: 'Create',
    system:
      'You are a full YouTube Studio Agent operating this channel\'s workspace. You write scripts, packages, plans, comment replies and analysis using the deterministic tools. ' +
      'You also operate the channel directly: upload finished videos (yt_upload), set visibility public/unlisted/private (yt_set_visibility), list uploads (yt_list_videos) and read stats (yt_video_stats) whenever the task calls for it — no extra confirmation beyond the permission gate. ' +
      'When the API cannot do it (channel customization, end screens, cards, some upload dialogs), drive the real Studio UI in the shared visible browser with the browser_* tools: navigate, browser_snapshot to see the page, then click/type/upload like a human. The human is watching that window. ' +
      'Follow voice.md exactly when it exists — it is the channel\'s real voice, not a suggestion. ' +
      'Before finalizing a script, run the hook through hook_score and revise until the weakest property is addressed. ' +
      'Before finalizing a title, run title_lint (pass thumbnail text too when you have it). ' +
      'Never invent a number, a result or a source.',
    permission: null,   // use config defaults
  },
  analyze: {
    id: 'analyze', primary: true, voice: false,
    label: 'Analyze',
    system:
      'You are a read-only YouTube analyst. You measure things with the deterministic tools and report what the data says — you never modify files. ' +
      'Report numbers exactly as the tools return them and label any estimate as an estimate. ' +
      'End every report with the single highest-leverage fix.',
    permission: {
      edit: 'deny', bash: { '*': 'deny', 'ls *': 'allow', 'pwd': 'allow' }, browser: 'deny',
    },
  },
  scout: {
    id: 'scout', primary: false, subagent: true, voice: false,
    label: 'Scout',
    system:
      'You are a research subagent. You gather facts (web, channel files, transcripts) and return a compact structured report to the parent agent. ' +
      'You never edit channel files. Cite a source for every claim, or mark it as inference.',
    permission: {
      edit: 'deny', bash: { '*': 'deny', 'ls *': 'allow', 'pwd': 'allow' },
      webfetch: 'allow', websearch: 'allow', browser: 'deny',
    },
  },
  reviewer: {
    id: 'reviewer', primary: false, subagent: true, voice: true,
    label: 'Reviewer',
    system:
      'You are a review subagent. You read a draft plus voice.md and return a strict, numbered critique: ' +
      '(1) voice mismatches with the exact offending line quoted, (2) hook problems (no open loop, no stakes, no specificity), ' +
      '(3) packaging problems (title/thumbnail redundancy, length), (4) any invented-sounding claim. ' +
      'You never rewrite the draft; you only critique it. If it is ready, say READY.',
    permission: {
      edit: 'deny', bash: { '*': 'deny', 'ls *': 'allow', 'pwd': 'allow' }, browser: 'deny',
    },
  },
};

function loadJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    log.warn('agents', `cannot read ${file}`, e);
    return null;
  }
}

/** all agents: built-ins + custom (custom with the same id overrides built-in) */
function allAgents() {
  const out = { ...BUILTINS };
  const dirs = [path.join(studioDir(), 'agents'), path.join(getWorkDir(), 'agents')];
  if (APP_ROOT) dirs.push(path.join(APP_ROOT, 'examples', 'agents'));
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const j = loadJsonSafe(path.join(d, f));
      if (j && j.id) out[j.id] = { ...(BUILTINS[j.id] || {}), ...j, id: j.id };
    }
  }
  return out;
}
const BINS = BUILTINS;

function getAgent(id) {
  const all = allAgents();
  return all[id] || all.create;
}

function systemPromptFor(agent, cfg, voiceText) {
  const base = [cfg.systemPrompt, agent.system].filter(Boolean).join('\n\n');
  if (agent.voice && voiceText) return base + '\n\n# voice.md (the channel voice — obey it)\n' + voiceText;
  return base;
}

module.exports = { BUILTINS, allAgents, getAgent, systemPromptFor };
