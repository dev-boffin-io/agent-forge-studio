'use strict';

// CLI — run the studio without the browser UI. The same agent loop, tools, permissions and
// browser automation are available from a terminal:
//
//   agent-forge-studio run "make a script about X"
//   agent-forge-studio chat
//   agent-forge-studio research "best camera for YouTube"
//   agent-forge-studio download https://example.com/clip.mp4 media/
//   agent-forge-studio skills search "video editing"
//   agent-forge-studio skills install anthropics/skills/document-skills/pdf
//   agent-forge-studio browser open https://studio.youtube.com
//
// Flags: --dir <path> --agent <id> --session <id> --model <ref> --yes --json --all --force

const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');

const COMMANDS = new Set(['run', 'ask', 'chat', 'skills', 'skill', 'install-skill', 'research', 'download', 'browser', 'help']);

function parseCli(argv) {
  const opts = { dir: null, agent: null, session: null, model: null, yes: false, json: false, all: false, force: false, includeText: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a === '-d') opts.dir = argv[++i];
    else if (a === '--agent' || a === '-a') opts.agent = argv[++i];
    else if (a === '--session' || a === '-s') opts.session = argv[++i];
    else if (a === '--model' || a === '-m') opts.model = argv[++i];
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--text') opts.includeText = true;
    else if (a === '--prompt' || a === '-r') { rest.push('run', argv[++i]); }
    else rest.push(a);
  }
  let command = rest.shift() || 'help';
  if (command === 'install-skill') { command = 'skills'; rest.unshift('install'); }
  return { command, args: rest, opts };
}

/** True when argv asks for a CLI command (so server.js should not start the HTTP UI). */
function handles(argv) {
  if (!Array.isArray(argv) || !argv.length) return false;
  if (argv.includes('--prompt') || argv.includes('-r')) return true;
  const takesValue = new Set(['--dir', '-d', '--agent', '-a', '--session', '-s', '--model', '-m']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y' || a === '--json' || a === '--all' || a === '--force' || a === '--text') continue;
    if (takesValue.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return COMMANDS.has(a);
  }
  return false;
}

const HELP = `agent-forge-studio — command line

Usage:
  agent-forge-studio run "<task>"            run one agent task
  agent-forge-studio chat                    interactive agent session
  agent-forge-studio research "<query>"      search + read the top web pages
  agent-forge-studio download <url> [path]   download a file into the workspace
  agent-forge-studio skills list             list installed + built-in skills
  agent-forge-studio skills search "<q>"     discover skills on GitHub
  agent-forge-studio skills repo <source>    show the skills inside a GitHub repo
  agent-forge-studio skills install <source> install one (add --all for every skill)
  agent-forge-studio skills remove <id>      remove an installed skill
  agent-forge-studio browser open [url]      open the visible automation browser
  agent-forge-studio browser snapshot        describe the current page
  agent-forge-studio browser close           save login and close the browser
  agent-forge-studio help

Flags:
  -d, --dir <path>       channel workspace (default: cwd)
  -a, --agent <id>       agent to use (default: config agent, usually create)
  -m, --model <ref>      override the configured model
      --session <id>     continue an existing session
  -y, --yes              auto-approve permission prompts for this run
      --json             machine-readable output where supported
      --all              install every skill found at the source
      --force            replace an installed skill
`;

function setWorkspace(opts) {
  const cfg = require('./config');
  cfg.setWorkDir(opts.dir || process.cwd());
  return cfg;
}

function print(obj, opts) {
  if (opts && opts.json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else process.stdout.write(typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj, null, 2) + '\n');
}

function short(s, n = 500) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function runAgent(prompt, opts, { chatSession = null } = {}) {
  const cfgLib = require('./config');
  const sessions = require('./sessions');
  const agents = require('./agents');
  const agentLib = require('./agent');
  const { makeGate } = require('./permission');
  const commands = require('./commands');

  const cfg = cfgLib.loadConfig();
  if (opts.model) cfg.model = opts.model;
  if (opts.agent) cfg.agent = opts.agent;
  if (!cfg.model) throw new Error('no model selected — pass --model or set "model" in config.json');

  const agentId = cfg.agent || 'create';
  let session = chatSession;
  if (!session) {
    session = opts.session ? sessions.loadSession(opts.session) : sessions.createSession({ title: 'CLI session', agent: agentId });
  }
  if (opts.agent) { session.agent = opts.agent; sessions.saveSession(session); }

  const expanded = commands.expand(prompt);
  sessions.append(session, { role: 'user', content: expanded ? expanded.text : prompt });
  if (expanded) process.stderr.write(`/${expanded.name}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  const ask = async (question) => {
    if (opts.yes || !process.stdin.isTTY) return 'allow';
    const a = String(await rl.question(question + ' ')).trim().toLowerCase();
    if (!a || a === 'n' || a === 'no') return 'deny';
    if (a === 'o' || a === 'once') return 'once';
    return 'allow';
  };

  const agent = agents.getAgent(agentId);
  const gate = makeGate(
    Object.assign({}, cfg.permission, agent.permission || {}),
    async ({ category, subject }) => ask(`allow ${category}${subject ? ': ' + short(subject, 120) : ''}? [y/N/o]`),
  );

  let streamed = '';
  let printedTool = false;
  const emit = (event, data = {}) => {
    if (opts.json) {
      if (event === 'token' || event === 'thinking') return;
      process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
      return;
    }
    if (event === 'token') { process.stdout.write(data.text || ''); streamed += data.text || ''; return; }
    if (event === 'thinking') return;
    if (event === 'tool_call') {
      printedTool = true;
      process.stderr.write(`\n⚙ ${data.name} ${short(data.args, 180)}\n`);
      return;
    }
    if (event === 'tool_result') {
      process.stderr.write(`  ${data.error ? '✖' : '←'} ${short(data.content, 400)}\n`);
      return;
    }
    if (event === 'warning') { process.stderr.write(`\n! ${data.message}\n`); return; }
    if (event === 'error') { process.stderr.write(`\n✖ ${data.message}\n`); return; }
    if (event === 'permission_request') {
      process.stderr.write(`\n? ${data.category}: ${short(data.subject || data.label, 160)}\n`);
      return;
    }
    if (event === 'question') { process.stderr.write(`\n? ${data.question}\n`); return; }
  };

  try {
    const result = await agentLib.runLoop({
      session,
      cfg,
      emit,
      gate,
      onQuestion: async (question) => (opts.yes || !process.stdin.isTTY ? '' : String(await rl.question(`\n? ${question}\n> `))),
      onSubagent: agentLib.runSubagent,
    });
    if (!opts.json) {
      if (!streamed && result.text) process.stdout.write(result.text);
      if (streamed || result.text) process.stdout.write('\n');
    }
    return result;
  } finally {
    rl.close();
  }
}

async function cliSkills(args, opts) {
  const hub = require('./skillhub');
  const skills = require('./skills');
  const [sub, ...rest] = args;
  const arg = rest.join(' ').trim();

  if (!sub || sub === 'list') {
    const all = skills.listSkills();
    const installed = hub.installedSkills();
    if (opts.json) return print({ skills: all, installed }, opts);
    process.stdout.write(`Skills (${all.length}):\n`);
    for (const s of all) {
      const from = installed.find((i) => i.id === s.id);
      process.stdout.write(`  ${s.id.padEnd(24)} ${s.description || s.name}${from ? `  [${from.repo}]` : ''}\n`);
    }
    return;
  }
  if (sub === 'search') {
    const data = await hub.discoverSkills(arg, { limit: 15 });
    if (opts.json) return print(data, opts);
    if (!data.repos.length) return print('No skill repositories found.');
    process.stdout.write(`Skill repositories${data.query ? ` for "${data.query}"` : ''}:\n`);
    for (const r of data.repos) {
      process.stdout.write(`  ${r.fullName}${r.stars != null ? `  ★ ${r.stars}` : ''}\n    ${r.description}\n`);
    }
    process.stdout.write('\nBrowse with: agent-forge-studio skills repo <owner/repo>\n');
    return;
  }
  if (sub === 'repo' || sub === 'browse' || sub === 'show') {
    if (!arg) throw new Error('usage: skills repo owner/repo[/path]');
    const data = await hub.listGitHubSkills(arg);
    if (opts.json) return print(data, opts);
    process.stdout.write(`${data.repo} @ ${data.ref} — ${data.skills.length} skill(s)\n`);
    for (const s of data.skills) process.stdout.write(`  ${s.id.padEnd(28)} ${s.path}\n    ${s.description || s.name}\n`);
    return;
  }
  if (sub === 'install' || sub === 'add') {
    if (!arg) throw new Error('usage: skills install owner/repo[/path] [--all] [--force]');
    const result = await hub.installSkill(arg, { all: opts.all, force: opts.force });
    if (!result.ok && result.needsSelection) {
      if (opts.json) return print(result, opts);
      process.stdout.write(`${result.error}\n`);
      for (const s of result.skills) process.stdout.write(`  ${s.id.padEnd(28)} ${s.path}\n`);
      process.stdout.write(`\nInstall one with: agent-forge-studio skills install ${arg}/${result.skills[0] ? result.skills[0].path : ''}\n`);
      return result;
    }
    if (opts.json) return print(result, opts);
    for (const s of result.installed) {
      process.stdout.write(`✓ ${s.id} — ${s.name} (${s.files} files)\n  ${s.description}\n  from ${s.source.repo}/${s.source.path} @ ${s.source.ref}\n`);
    }
    return result;
  }
  if (sub === 'remove' || sub === 'uninstall' || sub === 'rm') {
    if (!arg) throw new Error('usage: skills remove <id>');
    const r = hub.uninstallSkill(arg);
    return print(r, opts);
  }
  throw new Error(`unknown skills command: ${sub} (list, search, repo, install, remove)`);
}

async function cliBrowser(args, opts) {
  const browser = require('./browser');
  const [sub, ...rest] = args;
  if (!sub || sub === 'open') {
    const url = rest[0] || 'https://studio.youtube.com';
    const { page } = await browser.ensureBrowser({ headless: false });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const info = { ok: true, url: page.url(), title: await page.title(), auth: browser.authInfo() };
    if (opts.json) return print(info, opts);
    process.stdout.write(`Browser open: ${info.url}\n${info.title}\nLogin: ${info.auth.exists ? info.auth.file : 'not saved yet'}\n`);
    return info;
  }
  if (sub === 'close') {
    const r = await browser.closeBrowser();
    return print({ ok: true, ...r }, opts);
  }
  if (sub === 'snapshot') {
    const page = await browser.getPage();
    const snap = await browser.snapshot(page, { includeText: opts.includeText });
    if (opts.json) return print(snap, opts);
    process.stdout.write(`${snap.title} — ${snap.url}\n`);
    for (const e of snap.elements) {
      process.stdout.write(`  ${String(e.role).padEnd(14)} ${e.name}${e.selector ? `  [${e.selector}]` : ''}\n`);
    }
    if (snap.text) process.stdout.write(`\n${snap.text}\n`);
    return snap;
  }
  if (sub === 'navigate' || sub === 'goto') {
    if (!rest[0]) throw new Error('usage: browser navigate <url>');
    const page = await browser.getPage();
    await page.goto(rest[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await browser.maybeAutosave();
    return print({ ok: true, url: page.url(), title: await page.title() }, opts);
  }
  if (sub === 'download') {
    if (!rest[0]) throw new Error('usage: browser download <url> [path]');
    const page = await browser.getPage();
    const dl = await browser.downloadVia(page, { url: rest[0] });
    const ws = require('./workspace');
    const dest = rest[1] || path.posix.join('downloads', dl.filename || 'download');
    const abs = ws.safeResolve(dest);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, dl.buffer);
    return print({ ok: true, path: ws.rel(abs), bytes: dl.buffer.length }, opts);
  }
  throw new Error(`unknown browser command: ${sub} (open, snapshot, navigate, download, close)`);
}

async function cliResearch(args, opts) {
  const web = require('./web');
  const query = args.join(' ').trim();
  if (!query) throw new Error('usage: research <query>');
  const data = await web.research(query, { count: 8, fetchCount: 4 });
  if (opts.json) return print(data, opts);
  process.stdout.write(`Research: ${data.query}\n\n`);
  for (const r of data.results) {
    process.stdout.write(`• ${r.title || '(untitled)'}\n  ${r.url}\n`);
    if (r.snippet) process.stdout.write(`  ${r.snippet}\n`);
    if (r.content) process.stdout.write(`\n${r.content.slice(0, 4000)}\n`);
    if (r.error) process.stdout.write(`  ! ${r.error}\n`);
    process.stdout.write('\n');
  }
  return data;
}

async function cliDownload(args, opts) {
  const url = args[0];
  if (!url) throw new Error('usage: download <url> [workspace path]');
  const web = require('./web');
  const dest = args[1];
  let out;
  if (dest) {
    const dir = path.posix.dirname(dest.replace(/\\/g, '/'));
    out = await web.downloadUrl(url, { destDir: dir === '.' ? '' : dir, filename: path.posix.basename(dest), overwrite: true });
  } else {
    out = await web.downloadUrl(url);
  }
  return print(out, opts);
}

async function cliChat(opts) {
  const sessions = require('./sessions');
  const cfg = setWorkspace(opts).loadConfig();
  const session = sessions.createSession({ title: 'CLI chat', agent: opts.agent || cfg.agent || 'create' });
  process.stderr.write('Interactive agent. Type /exit to stop.\n');
  for (;;) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
    let line;
    try { line = String(await rl.question('you> ')).trim(); } finally { rl.close(); }
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    try {
      await runAgent(line, opts, { chatSession: session });
    } catch (e) {
      process.stderr.write(`✖ ${e.message}\n`);
    }
  }
  return { ok: true, sessionId: session.id };
}

async function run(argv) {
  const { command, args, opts } = parseCli(argv);
  if (command === 'help' || opts.help) { process.stdout.write(HELP); return { ok: true }; }
  if (command !== 'help') setWorkspace(opts);

  if (command === 'run' || command === 'ask') {
    const prompt = args.join(' ').trim();
    if (!prompt) throw new Error('usage: run "<task>"');
    return runAgent(prompt, opts);
  }
  if (command === 'chat') return cliChat(opts);
  if (command === 'skills' || command === 'skill') return cliSkills(args, opts);
  if (command === 'research') return cliResearch(args, opts);
  if (command === 'download') return cliDownload(args, opts);
  if (command === 'browser') return cliBrowser(args, opts);
  process.stdout.write(HELP);
  return { ok: true };
}

module.exports = { COMMANDS, HELP, handles, parseCli, run, runAgent };
