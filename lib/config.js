'use strict';

const log = require('./log');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { isSea } = require('./runtime');
const { writeSecretFile } = require('./secret-store');

// Source checkout: config.json + ./workspace live next to the code (as before).
// Single executable: there is no source tree, so the global config lives in GLOBAL_DIR instead.
const APP_ROOT = isSea() ? null : path.resolve(__dirname, '..');
const GLOBAL_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'youtube-studio');
const CONFIG_PATH = APP_ROOT ? path.join(APP_ROOT, 'config.json') : path.join(GLOBAL_DIR, 'config.json');
const LEGACY_WORKSPACE = APP_ROOT ? path.join(APP_ROOT, 'workspace') : null;

const DEFAULT_CONFIG = {
  endpoint: 'http://localhost:11434',
  model: '',
  agent: 'create',
  thinking: false,
  visionModel: '',             // optional: a vision-capable model that describes images when the chat model can't see them
  maxUploadMB: 500,
  recallAuto: true,            // auto-inject keyword matches from older history (SQLite FTS5; needs Node >= 22.5)
  temperature: 0.6,
  numCtx: 0,                   // 0 = auto (detect from the model, capped by autoCtxMax); or a fixed number
  autoCtxMax: 131072,
  smallModel: '',              // optional cheaper model ref for titles + summaries
  apiKey: '',                  // optional key for the default provider (plain local Ollama needs none)
  providers: {},               // extra providers: { id: { type: 'ollama'|'openai'|'anthropic', endpoint, apiKey|apiKeyEnv, contextWindow, maxTokens } }
  defaultProvider: 'default',  // 'default' = the top-level `endpoint`
  youtube: {                    // Google OAuth client for the YouTube Studio agent
    clientId: '',
    clientSecret: '',
    redirectUri: '',            // empty = derived from the request host (/auth/youtube/callback)
  },
  instagram: {                  // Meta Instagram OAuth credentials
    clientId: '',
    clientSecret: '',
    redirectUri: '',
  },
  facebook: {                   // Meta Facebook OAuth credentials
    clientId: '',
    clientSecret: '',
    redirectUri: '',
  },
  google: {                     // Google API credentials for other services
    clientId: '',
    clientSecret: '',
    redirectUri: '',
  },
  mcp: {},                     // { name: { type: 'local', command: [...], environment: {} } | { type: 'remote', url, headers } }
  lsp: {},                     // { name: { command: [...], extensions: ['.py'] } } or false to disable LSP
  websearch: { provider: 'exa' }, // exa | ddg | searxng (+ url) — automatic fallback across providers
  pexelsApiKey: '',             // Pexels API key for stock footage (or set PEXELS_API_KEY in the env)
  pixabayApiKey: '',            // Pixabay API key for stock footage (or set PIXABAY_API_KEY in the env)
  workers: {                    // local media workers (start with uvicorn; see workers/*/main.py)
    tts: 'http://127.0.0.1:8101',
    render: 'http://127.0.0.1:8102',
  },
  skills: { paths: [] },
  maxIterations: 200,
  requestTimeoutMs: 600000,
  autoCompact: true,
  wakeOnProcessExit: true,     // when a background process finishes and the agent is idle, start a short turn so it reports the result
  fsAccess: 'workspace',       // 'workspace' confines file tools to the project; 'system' allows absolute paths anywhere
  // rules; value = allow|ask|deny, or a pattern map (last matching rule wins).
  permission: {
    edit: 'allow',
    bash: {
      '*': 'ask', 'ls *': 'allow', 'pwd': 'allow', 'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow',
      'yt-dlp *': 'ask', 'whisper *': 'ask', 'ffmpeg *': 'ask', 'rm *': 'deny',
    },
    outside_workspace: 'ask', // file tools touching an absolute path outside the project (fsAccess must be 'system')
    publish: 'ask',           // anything public on YouTube (yt_upload / yt_set_visibility public) ALWAYS needs explicit consent
    browser_read: 'allow',    // navigate, snapshot, screenshots, wait
    browser_write: 'ask',     // click, type, select, upload, download, submit
  },
  instructions: [],            // extra instruction files, e.g. ["docs/rules.md", "~/my-rules.md"]
  toolOutput: {},              // { maxLines, maxBytes } before long tool output is saved to <studio data dir>/tool-output/
  systemPrompt:
    'You are an autonomous senior software engineer and multi-platform content agent working inside the current project directory. ' +
    'You read and change real files ONLY by calling the provided tools. Never invent file contents in plain text and claim they exist — actually call the tools. ' +
    'Work step by step: explore with list_files/glob/grep/read_file, then edit, then verify (tests/build). Prefer edit_file for small changes (copy old_string exactly from read_file output, without the line-number prefixes). All paths are relative to the project directory. ' +
    'You can also research, plan, create content, and operate across platforms (YouTube, Instagram, Facebook, Google). ' +
    'You draft scripts, packages, plans, replies and analysis with real tools, and you operate channels directly when asked: upload videos/posts (yt_upload, facebook_post_text/link/photo, instagram_publish_photo/reel), manage visibility/settings, list uploads and read stats. ' +
    'Never invent a number, a result or a source: if a figure would strengthen a line and you do not have one, ask for it or write the line without it. ' +
    'Use the deterministic tools (hook_score, title_lint, edit_list, chapters_from_transcript, retention_read, viral_rank) when relevant. ' +
    'Research the open web when facts matter, download reference assets into the workspace, upload artifacts with upload_file, and install a GitHub skill when a task needs a workflow you do not have. ' +
    'Use browser automation when platform APIs are unavailable or for tasks that require interacting with UIs. ' +
    'When finished, give a short summary of what you did.',
};

let workDir = process.cwd();

/** Directory the agent works in (wherever you launch it). */
function getWorkDir() { return workDir; }

// Studio data (sessions, uploads, recall index, snapshots, ...) lives in the user's HOME, never inside the project:
//   ~/.ytstudio/<project-name>-<hash>/{sessions,uploads,tool-output,plans,agents,skills,commands,snapshot.git,recall.db,config.json}
// One folder per project directory, so session data of different projects never mixes.
// Override the root with $YOUTUBE_STUDIO_HOME (or the legacy $OLLAMA_STUDIO_HOME).
const STUDIO_HOME = path.resolve(
  process.env.YOUTUBE_STUDIO_HOME || process.env.OLLAMA_STUDIO_HOME || path.join(os.homedir(), '.ytstudio'),
);
const VIRTUAL_PREFIX = '.studio';        // canonical prefix used in tool paths (".studio/uploads/x")
const VIRTUAL_ALIASES = ['.studio', '.ytstudio']; // .ytstudio is kept for data/skills created by older builds

function projectKey(dir) {
  const name = path.basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 40) || 'project';
  return `${name}-${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8)}`;
}
function studioRoot() { return STUDIO_HOME; }
function studioDir() { return path.join(STUDIO_HOME, projectKey(workDir)); }

function setWorkDir(dir) {
  const resolved = path.resolve(String(dir || process.cwd()));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  workDir = fs.realpathSync(resolved);
  // Launched from the app's own folder? Use the legacy sandbox so the studio never edits itself.
  if (APP_ROOT && workDir === APP_ROOT) {
    fs.mkdirSync(LEGACY_WORKSPACE, { recursive: true });
    workDir = fs.realpathSync(LEGACY_WORKSPACE);
  }
  fs.mkdirSync(studioDir(), { recursive: true });
  const meta = path.join(studioDir(), 'project.json');
  if (!fs.existsSync(meta)) writeSecretFile(meta, JSON.stringify({ path: workDir, created: new Date().toISOString() }, null, 2) + '\n');
  return workDir;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log.warn('config', `cannot read ${file}`, e);
    return {};
  }
  try { return JSON.parse(raw); } catch (e) {
    // a hand-edited file with a typo: say so (once), keep a copy, and fall back to defaults instead of crashing
    log.error('config', `${file} is not valid JSON — using defaults until it is fixed`, e);
    try { fs.copyFileSync(file, file + '.broken'); } catch (e2) { log.debug('config', 'could not back up the broken config', e2); }
    return {};
  }
}

/** defaults < global config.json < <studio data dir>/config.json (~/.ytstudio/<project>/config.json) */
function loadConfig() {
  const global = readJson(CONFIG_PATH);
  const local = readJson(path.join(studioDir(), 'config.json'));
  const merged = { ...DEFAULT_CONFIG, ...global, ...local };
  merged.permission = { ...DEFAULT_CONFIG.permission, ...(global.permission || {}), ...(local.permission || {}) };
  for (const k of ['providers', 'mcp']) merged[k] = { ...(global[k] || {}), ...(local[k] || {}) };
  return merged;
}

function saveConfig(patch) {
  const current = readJson(CONFIG_PATH);
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.providers) {
    // the browser only ever sees masked keys; keep the stored secret when it sends the mask back
    const old = current.providers || {};
    next.providers = {};
    for (const [id, p] of Object.entries(patch.providers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || id === 'default') continue;
      const np = { ...p };
      if (typeof np.apiKey === 'string' && np.apiKey.startsWith('••••')) np.apiKey = (old[id] && old[id].apiKey) || '';
      if (!np.apiKey) delete np.apiKey;
      next.providers[id] = np;
    }
  }
  if (patch && typeof patch.apiKey === 'string' && patch.apiKey.startsWith('••••')) next.apiKey = current.apiKey || '';
  if (!next.apiKey) delete next.apiKey;
  for (const provider of ['youtube', 'instagram', 'facebook', 'google']) {
    if (patch && patch[provider]) {
      const old = current[provider] || {};
      next[provider] = { ...old, ...patch[provider] };
      if (typeof next[provider].clientSecret === 'string' && next[provider].clientSecret.startsWith('••••')) next[provider].clientSecret = old.clientSecret || '';
      next[provider].clientId = String(next[provider].clientId || '').trim();
      next[provider].clientSecret = String(next[provider].clientSecret || '').trim();
      next[provider].redirectUri = String(next[provider].redirectUri || '').trim() || (old.redirectUri || '');
      if (!next[provider].clientId && !next[provider].clientSecret) delete next[provider];
    }
  }
  if (typeof next.endpoint === 'string') next.endpoint = next.endpoint.trim().replace(/\/+$/, '');
  if (!next.endpoint) next.endpoint = DEFAULT_CONFIG.endpoint;
  // The app-root config lives beside the checkout, not in a dedicated secret dir: chmod the
  // file to 0600 but never chmod the checkout itself to 0700.
  writeSecretFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { secureDir: !APP_ROOT });
  return loadConfig();
}

module.exports = {
  APP_ROOT, CONFIG_PATH, GLOBAL_DIR, DEFAULT_CONFIG,
  getWorkDir, setWorkDir, studioDir, studioRoot, projectKey, VIRTUAL_PREFIX, VIRTUAL_ALIASES, loadConfig, saveConfig,
};
