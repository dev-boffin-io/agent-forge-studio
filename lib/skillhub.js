'use strict';

// Skill hub — discover and install agent skills directly from GitHub.
//
// A skill is a folder containing a SKILL.md (frontmatter: name, description) plus any reference
// files or scripts it needs. Sources can be:
//   owner/repo
//   owner/repo#branch
//   owner/repo/path/to/skill
//   https://github.com/owner/repo/tree/branch/path/to/skill
//   https://raw.githubusercontent.com/owner/repo/branch/path/SKILL.md
//
// Installed skills live in the channel's studio data dir (…/.ytstudio/<channel>/skills/<id>/),
// so they never modify the app checkout and stay isolated per channel.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { studioDir } = require('./config');
const { parseFrontmatter } = require('./skills');
const { fetchOk } = require('./errors');
const log = require('./log');

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const UA = 'agent-forge-studio/1.0 (+https://github.com/dev-boffin-io)';
const MAX_FILES = 80;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_SKILLS = 100;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const previews = new Map(); // previewToken -> { source, sha, id, path, all, createdAt }

const FLAG_RULES = [
  { rule: 'publish', label: 'mentions publishing', re: /\bpublish(?:es|ed|ing|er)?\b/i },
  { rule: 'upload', label: 'mentions uploading', re: /\bupload(?:s|ed|ing)?\b/i },
  { rule: 'delete', label: 'mentions deleting', re: /\bdelete(?:s|d|ing)?\b|\bremove(?:s|d|ing)?\b/i },
  { rule: 'ignore-instructions', label: 'tries to override earlier instructions', re: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i },
  { rule: 'system-prompt', label: 'mentions the system prompt', re: /\bsystem\s+prompt\b/i },
  { rule: 'api-key', label: 'mentions API keys', re: /\bapi[ _-]?key\b/i },
  { rule: 'token', label: 'mentions tokens', re: /\b(?:access[ _-]?)?tokens?\b/i },
  { rule: 'password', label: 'mentions passwords', re: /\bpass(?:word|phrase)\b/i },
  { rule: 'network-command', label: 'contains curl/wget/fetch', re: /\b(?:curl|wget)\b|\bfetch\s*\(/i },
  { rule: 'base64', label: 'contains a base64-looking blob', re: /(?:[A-Za-z0-9+/]{80,}={0,2})|\bbase64\b/i },
];

function lineFor(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 180);
}

function scanText(file, text) {
  const out = [];
  if (!text) return out;
  for (const r of FLAG_RULES) {
    const m = r.re.exec(text);
    if (m) out.push({ file, rule: r.rule, label: r.label, excerpt: lineFor(text, m.index) });
  }
  if (/\b(?:curl|wget)\b|\bfetch\s*\(/i.test(text) && /https?:\/\//i.test(text)) {
    const urls = text.match(/https?:\/\/[^\s)'"<>]+/gi) || [];
    if (urls.length) out.push({ file, rule: 'external-url', label: 'references an external URL', excerpt: urls[0].slice(0, 180) });
  }
  if (/\.(?:sh|py|js|ps1)$/i.test(file) && /^\s*#!/.test(text)) {
    out.push({ file, rule: 'shebang-script', label: 'bundled executable script with a shebang', excerpt: text.split(/\r?\n/)[0].slice(0, 180) });
  }
  return out;
}

function scanFiles(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    for (const f of scanText(e.file, e.text)) {
      const key = `${f.file}|${f.rule}`;
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
  }
  return out;
}

function textFromBuffer(buf) {
  if (!buf || buf.includes(0)) return '';
  return buf.toString('utf8');
}

const FEATURED = [
  {
    fullName: 'anthropics/skills',
    description: 'Anthropic\'s official collection of reusable Agent Skills (documents, design, MCP, testing and more).',
    url: 'https://github.com/anthropics/skills',
    stars: null,
    featured: true,
  },
  {
    fullName: 'obra/superpowers',
    description: 'A library of composable agentic skills: planning, debugging, TDD, code review and delivery workflows.',
    url: 'https://github.com/obra/superpowers',
    stars: null,
    featured: true,
  },
  {
    fullName: 'Jakeschincariol/youtube-agent-skill',
    description: 'The YouTube agent skill collection this studio was originally ported from.',
    url: 'https://github.com/Jakeschincariol/youtube-agent-skill',
    stars: null,
    featured: true,
  },
];

const repoCache = new Map(); // owner/repo -> repo info (default_branch etc.)

function githubHeaders() {
  const h = {
    'user-agent': UA,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(url, { method = 'GET', body } = {}) {
  const res = await fetchOk(url, {
    method,
    headers: { ...githubHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  }, { source: 'GitHub API', where: 'api.github.com' });
  return res.json();
}

async function rawFile(url, { maxBytes = MAX_FILE_BYTES } = {}) {
  const res = await fetchOk(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  }, { source: 'GitHub raw file', where: 'raw.githubusercontent.com' });
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`file is too large (${declared} bytes; limit ${maxBytes})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file is too large (${buf.length} bytes; limit ${maxBytes})`);
  return buf;
}

/** Parse any supported GitHub shorthand/URL into {owner, repo, ref, path}. Pure. */
function parseSource(input) {
  let s = String(input || '').trim().replace(/^github:/i, '');
  if (!s) throw new Error('a GitHub source is required (owner/repo[/path] or a github.com URL)');

  let ref = null;
  const hash = s.lastIndexOf('#');
  if (hash > 0) {
    ref = s.slice(hash + 1).trim() || null;
    s = s.slice(0, hash);
  }

  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new Error(`not a valid URL: ${s}`); }
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    if (host === 'raw.githubusercontent.com') {
      if (parts.length < 3) throw new Error('raw.githubusercontent.com URL needs /owner/repo/ref/path');
      const [owner, repo, ...rest] = parts;
      return { owner, repo, ref: ref || rest.shift(), path: rest.join('/') };
    }
    if (host !== 'github.com' && host !== 'www.github.com') {
      throw new Error('only github.com and raw.githubusercontent.com URLs are supported');
    }
    if (parts.length < 2) throw new Error('GitHub URL needs /owner/repo');
    const [owner, repo, ...rest] = parts;
    let filePath = '';
    if (rest[0] === 'tree' || rest[0] === 'blob') {
      ref = ref || rest[1] || null;
      filePath = rest.slice(2).join('/');
    } else {
      filePath = rest.join('/');
    }
    return { owner, repo, ref, path: filePath };
  }

  s = s.replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('expected owner/repo or owner/repo/path');
  let owner = parts.shift();
  let repo = parts.shift();
  const at = repo.lastIndexOf('@');
  if (at > 0) { ref = ref || repo.slice(at + 1); repo = repo.slice(0, at); }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid GitHub repository: ${owner}/${repo}`);
  }
  return { owner, repo, ref, path: parts.join('/') };
}

/** Safe skill id from a folder name (or explicit id). Pure. */
function skillId(name) {
  const base = String(name || 'skill').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'skill';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64);
  return clean || 'skill';
}

function rawUrl(owner, repo, ref, filePath) {
  const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  return `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${enc(ref)}/${enc(filePath)}`;
}

function skillsRoot() { return path.join(studioDir(), 'skills'); }

async function repoInfo(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  if (repoCache.has(key)) return repoCache.get(key);
  const data = await ghJson(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  const info = {
    owner, repo,
    fullName: data.full_name || `${owner}/${repo}`,
    defaultBranch: data.default_branch || 'main',
    description: data.description || '',
    stars: data.stargazers_count || 0,
    url: data.html_url || `https://github.com/${owner}/${repo}`,
    sizeKb: data.size || 0,
    archived: !!data.archived,
  };
  repoCache.set(key, info);
  return info;
}

async function resolveCommit(owner, repo, ref) {
  const data = await ghJson(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`);
  if (!data || !data.sha) throw new Error(`could not resolve ${owner}/${repo}@${ref} to a commit SHA`);
  return data.sha;
}

async function repoTree(owner, repo, ref) {
  const data = await ghJson(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const files = (data.tree || []).filter((t) => t && t.type === 'blob' && t.path);
  return { files, truncated: !!data.truncated };
}

async function loadRepo(source) {
  const parsed = parseSource(source);
  const info = await repoInfo(parsed.owner, parsed.repo);
  const ref = parsed.ref || info.defaultBranch;
  const tree = await repoTree(parsed.owner, parsed.repo, ref);
  return { parsed: { ...parsed, ref }, info, ...tree };
}

function skillPaths(files, wanted = '') {
  const all = files.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  const p = String(wanted || '').replace(/^\/+|\/+$/g, '');
  if (!p) return all;
  if (/SKILL\.md$/i.test(p)) return all.filter((f) => f.path === p);
  return all.filter((f) => f.path === `${p}/SKILL.md` || f.path.startsWith(`${p}/`));
}

/** Public: discover GitHub repositories that publish agent skills. */
async function discoverSkills(query = '', { limit = 10 } = {}) {
  const q = String(query || '').trim();
  const featured = q ? [] : FEATURED.slice();
  if (!q) return { query: q, repos: featured, source: 'featured' };
  const search = `${q} skill in:name,description,readme`;
  const data = await ghJson(`${API}/search/repositories?q=${encodeURIComponent(search)}&sort=stars&order=desc&per_page=${Math.min(30, Math.max(1, Number(limit) || 10))}`);
  const repos = (data.items || []).map((r) => ({
    fullName: r.full_name,
    description: r.description || '',
    url: r.html_url,
    stars: r.stargazers_count || 0,
    defaultBranch: r.default_branch || 'main',
  }));
  return { query: q, repos, source: 'github-search' };
}

/** Public: list the skills inside a GitHub repository/path without installing them. */
async function listGitHubSkills(source) {
  const { parsed, info, files, truncated } = await loadRepo(source);
  const wanted = skillPaths(files, parsed.path).slice(0, MAX_SKILLS);
  if (!wanted.length) {
    throw new Error(`no SKILL.md found in ${info.fullName}${parsed.path ? '/' + parsed.path : ''} (ref ${parsed.ref})`);
  }
  const skills = [];
  const used = new Set();
  for (let i = 0; i < wanted.length; i += 6) {
    const batch = wanted.slice(i, i + 6);
    const loaded = await Promise.all(batch.map(async (f) => {
      const dir = f.path.replace(/\/SKILL\.md$/i, '');
      let meta = {};
      try {
        const raw = await rawFile(rawUrl(parsed.owner, parsed.repo, parsed.ref, f.path), { maxBytes: 256 * 1024 });
        meta = parseFrontmatter(raw.toString('utf8')).meta;
      } catch (e) {
        log.warn('skillhub', `could not read ${f.path}`, e);
      }
      return {
        id: skillId(dir),
        path: dir,
        name: meta.name || skillId(dir),
        description: meta.description || '',
        url: `${info.url}/blob/${encodeURIComponent(parsed.ref)}/${f.path}`,
      };
    }));
    for (const s of loaded) {
      let id = s.id;
      let n = 2;
      while (used.has(id)) id = `${s.id}-${n++}`;
      used.add(id);
      skills.push({ ...s, id });
    }
  }
  return {
    repo: info.fullName,
    url: info.url,
    ref: parsed.ref,
    truncated,
    skills,
  };
}

function selectTargets(wanted, { id, all = false } = {}) {
  const selected = [];
  const used = new Set();
  for (const f of wanted) {
    const dir = f.path.replace(/\/SKILL\.md$/i, '');
    let skill = skillId(dir);
    if (id && wanted.length === 1) skill = skillId(id);
    if (used.has(skill)) skill = `${skill}-${used.size + 1}`;
    used.add(skill);
    selected.push({ id: skill, dir, skillFile: f.path });
  }
  if (!all && selected.length > 1) return { needsSelection: true, selected };
  return { needsSelection: false, targets: all ? selected : [selected[0]], selected };
}

function memberRel(target, memberPath) {
  const dirPrefix = target.dir ? target.dir + '/' : '';
  return target.dir ? memberPath.slice(dirPrefix.length) : path.basename(memberPath);
}

function assertSafeMember(target, memberPath, rel) {
  const clean = String(rel).replace(/\\/g, '/');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`unsafe path in repo: ${memberPath}`);
  }
  return clean;
}

function assertSafeTarget(target) {
  const dir = String(target.dir || '').replace(/\\/g, '/');
  if (dir.startsWith('/') || dir.split('/').some((s) => s === '..' || s === '.')) {
    throw new Error(`unsafe skill path in repo: ${target.dir || target.skillFile}`);
  }
}

function membersFor(files, target) {
  assertSafeTarget(target);
  const dirPrefix = target.dir ? target.dir + '/' : '';
  const members = files.filter((f) => f.path === target.skillFile || (dirPrefix && f.path.startsWith(dirPrefix)));
  if (!members.length) throw new Error(`cannot read files for ${target.id}`);
  for (const m of members) assertSafeMember(target, m.path, memberRel(target, m.path));
  if (members.length > MAX_FILES) throw new Error(`${target.id} has ${members.length} files (limit ${MAX_FILES})`);
  return members;
}

function previewRecord(token, data) {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.createdAt > PREVIEW_TTL_MS) previews.delete(k);
  previews.set(token, { ...data, createdAt: now });
}

/**
 * Review a GitHub skill without writing anything. Pins the source to an immutable commit SHA.
 * Installation must be confirmed separately with confirmInstall() and the same SHA.
 */
async function previewInstall(source, { id, path: wantedPath, all = false } = {}) {
  const parsed = parseSource(source);
  const info = await repoInfo(parsed.owner, parsed.repo);
  const requestedRef = parsed.ref || info.defaultBranch;
  const sha = await resolveCommit(parsed.owner, parsed.repo, requestedRef);
  const tree = await repoTree(parsed.owner, parsed.repo, sha);
  const wanted = skillPaths(tree.files, wantedPath || parsed.path);
  if (!wanted.length) {
    throw new Error(`no SKILL.md found in ${info.fullName}${wantedPath || parsed.path ? '/' + (wantedPath || parsed.path) : ''} (commit ${sha})`);
  }

  const selection = selectTargets(wanted, { id, all });
  if (selection.needsSelection) {
    return {
      ok: false,
      needsSelection: true,
      repo: info.fullName,
      ref: requestedRef,
      commit: sha,
      sha,
      skills: selection.selected.map((s) => ({ id: s.id, path: s.dir, url: `${info.url}/blob/${sha}/${s.skillFile}` })),
      error: `this source contains ${selection.selected.length} skills — choose one (path/id) or pass all=true`,
    };
  }

  const files = [];
  const scanEntries = [];
  const documents = [];
  let total = 0;
  for (const target of selection.targets) {
    const members = membersFor(tree.files, target);
    for (const member of members) {
      const rel = assertSafeMember(target, member.path, memberRel(target, member.path));
      const buf = await rawFile(rawUrl(parsed.owner, parsed.repo, sha, member.path));
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`skill preview exceeds the ${MAX_TOTAL_BYTES}-byte limit`);
      files.push({ path: rel, repoPath: member.path, size: buf.length, skill: target.id });
      const text = textFromBuffer(buf);
      if (text) scanEntries.push({ file: rel, text });
      if (member.path === target.skillFile) documents.push({ id: target.id, path: target.dir, text });
    }
  }
  if (!documents.length) throw new Error('preview did not contain a readable SKILL.md');

  const token = crypto.randomBytes(24).toString('hex');
  const flags = scanFiles(scanEntries);
  previewRecord(token, { source, sha, id, path: wantedPath, all: !!all, repo: info.fullName, url: info.url, flags });
  const skillMd = documents.length === 1
    ? documents[0].text
    : documents.map((d) => `# ${d.id}\n\n${d.text}`).join('\n\n');
  return {
    ok: true,
    preview: true,
    previewToken: token,
    repo: info.fullName,
    url: info.url,
    ref: requestedRef,
    commit: sha,
    sha,
    files,
    skillMd,
    flags,
    skills: selection.targets.map((t) => ({ id: t.id, path: t.dir, skillFile: t.skillFile })),
  };
}

/** Confirm a preview and install exactly the previewed commit SHA. */
async function confirmInstall(source, { sha, previewToken, force = false } = {}) {
  const token = String(previewToken || '');
  const preview = previews.get(token);
  if (!preview) throw new Error('preview required — review the skill and confirm with its preview token');
  if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
    previews.delete(token);
    throw new Error('the skill preview expired — preview it again');
  }
  if (!sha || String(sha) !== preview.sha) {
    throw new Error(`commit SHA does not match the previewed commit (${preview.sha})`);
  }

  const parsed = parseSource(preview.source);
  const info = await repoInfo(parsed.owner, parsed.repo);
  const tree = await repoTree(parsed.owner, parsed.repo, preview.sha);
  const wanted = skillPaths(tree.files, preview.path || parsed.path);
  if (!wanted.length) throw new Error(`no SKILL.md found at commit ${preview.sha}`);
  const selection = selectTargets(wanted, { id: preview.id, all: preview.all });
  if (selection.needsSelection) throw new Error('the preview is stale — review the skill again');

  const installed = [];
  for (const target of selection.targets) {
    installed.push(await installOne({ parsed: { ...parsed, ref: preview.sha }, info, files: tree.files, target, force: !!force, flags: preview.flags || [] }));
  }
  previews.delete(token);
  require('./skills').clearCache();
  return { ok: true, preview: false, repo: info.fullName, commit: preview.sha, sha: preview.sha, installed };
}

/**
 * Backwards-compatible entry point: without a SHA/token it previews; with both it installs the
 * exact previewed commit. Never writes before a preview has been reviewed.
 */
async function installSkill(source, opts = {}) {
  if (opts && (opts.sha || opts.previewToken)) return confirmInstall(source, opts);
  return previewInstall(source, opts);
}

async function installOne({ parsed, info, files, target, force, flags = [] }) {
  const members = membersFor(files, target);
  const root = skillsRoot();
  const dest = path.join(root, target.id);
  if (fs.existsSync(dest) && !force) {
    const err = new Error(`skill "${target.id}" is already installed — pass force=true to replace it`);
    err.code = 'EEXIST';
    throw err;
  }
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.install-${target.id}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  let total = 0;
  try {
    for (const member of members) {
      const rel = assertSafeMember(target, member.path, memberRel(target, member.path));
      const abs = path.join(tmp, rel);
      if (!abs.startsWith(tmp + path.sep)) throw new Error(`unsafe path in repo: ${member.path}`);
      const buf = await rawFile(rawUrl(parsed.owner, parsed.repo, parsed.ref, member.path));
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`${target.id} exceeds the ${MAX_TOTAL_BYTES}-byte install limit`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }

    const skillFile = path.join(tmp, 'SKILL.md');
    if (!fs.existsSync(skillFile)) throw new Error(`${target.id} has no SKILL.md at its root`);
    const raw = fs.readFileSync(skillFile, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!body.trim()) throw new Error(`${target.id}/SKILL.md is empty`);
    const metaFile = {
      repo: info.fullName,
      url: info.url,
      ref: parsed.ref,
      commit: parsed.ref,
      path: target.dir,
      trusted: false,
      flags: flags.filter((f) => members.some((m) => memberRel(target, m.path) === f.file)),
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, '.source.json'), JSON.stringify(metaFile, null, 2) + '\n', 'utf8');

    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    log.info('skillhub', `installed ${target.id} from ${info.fullName} (${members.length} files @ ${parsed.ref})`);
    return {
      id: target.id,
      name: meta.name || target.id,
      description: meta.description || '',
      files: members.length,
      bytes: total,
      trusted: false,
      source: metaFile,
      installedPath: dest,
    };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** Remove an installed (non built-in) skill. */
function uninstallSkill(id) {
  const clean = skillId(id);
  const dest = path.join(skillsRoot(), clean);
  if (!fs.existsSync(dest)) throw Object.assign(new Error(`skill not installed: ${clean}`), { code: 'ENOENT' });
  fs.rmSync(dest, { recursive: true, force: true });
  require('./skills').clearCache();
  return { ok: true, id: clean };
}

/** Installed skills that were fetched from GitHub (have .source.json). */
function installedSkills() {
  const root = skillsRoot();
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, e.name, '.source.json'), 'utf8'));
      out.push({ id: e.name, ...meta });
    } catch { /* not installed from GitHub */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  FEATURED, parseSource, skillId, rawUrl, skillsRoot,
  discoverSkills, listGitHubSkills, previewInstall, confirmInstall, installSkill, uninstallSkill, installedSkills,
  resolveCommit, scanText,
};
