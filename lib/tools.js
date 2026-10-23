'use strict';

// Tools — the surface the model can call. Every tool: {name, description, parameters(json-schema), category, exec(args)}.
// Categories drive the permission gate (edit|bash|read|webfetch|websearch|skill|task).
// The six YouTube analyzers are deterministic Node ports and are categorised as 'read' so a
// read-only agent can still measure things.

const log = require('./log');
const ws = require('./workspace');
const yt = require('./youtube');
const voice = require('./youtube/voice');
const browser = require('./browser');
const { fetchOk } = require('./errors');

const path = require('node:path');
const slugify = (text) => String(text || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const pExec = promisify(exec);

const MAX_BASH_MS = 600000; // 10 minutes hard cap

function parseArgsJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { throw new Error(`arguments are not valid JSON: ${e.message}`); }
}

/** Base URL of a media worker from config, e.g. cfg.ttsWorkerUrl / cfg.renderWorkerUrl. */
function workerUrl(cfg, which) {
  const c = cfg || {};
  const defaults = { tts: 'http://127.0.0.1:8101', render: 'http://127.0.0.1:8102' };
  const key = which === 'tts' ? ['ttsWorkerUrl', 'ttsWorker'] : ['renderWorkerUrl', 'renderWorker'];
  const workers = c.workers || {};
  const val = key.map((k) => c[k]).find((v) => typeof v === 'string' && v.trim())
    || (which === 'tts' ? workers.tts : workers.render)
    || defaults[which];
  return String(val).replace(/\/+$/, '');
}

/**
 * POST JSON to a media worker and return the parsed JSON body. Throws a readable error when the
 * worker is unreachable or answers non-2xx (fetchOk handles both), so a missing worker surfaces
 * cleanly instead of hanging.
 */
async function workerPost(cfg, which, routePath, payload) {
  const url = workerUrl(cfg, which) + routePath;
  const timeoutMs = Number(cfg && cfg.requestTimeoutMs) || 600000;
  const signals = [];
  if (cfg && cfg.signal) signals.push(cfg.signal);
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(timeoutMs));
  const signal = signals.length && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
  const res = await fetchOk(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }, { source: which + '-worker', where: new URL(url).host });
  return res.json();
}

const TOOLS = [
  // ---- file ops (workspace-confined) ----
  {
    name: 'list_files', category: 'read',
    description: 'List files in a workspace directory. Returns [{path, type, size?}]. Paths are relative to the channel workspace root. The virtual folder ".ytstudio/" is studio-internal data.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'directory path, "." for root' }, recursive: { type: 'boolean' } }, required: ['path'] },
    exec: ({ path, recursive }) => {
      const abs = ws.safeResolve(path || '.');
      return { files: ws.listDir(abs, { recursive: !!recursive }) };
    },
  },
  {
    name: 'glob', category: 'read',
    description: 'Find files by pattern ("*.srt", "scripts/**"). Returns workspace-relative paths.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    exec: ({ pattern }) => ({ files: ws.glob(pattern) }),
  },
  {
    name: 'grep', category: 'read',
    description: 'Search file contents with a regular expression. Returns [{path, line, text}].',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'optional subdirectory' } }, required: ['pattern'] },
    exec: ({ pattern, path }) => ({ matches: ws.grep(pattern, {}) }),
  },
  {
    name: 'read_file', category: 'read',
    description: 'Read a text file from the workspace. Returns the full content.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    exec: ({ path }) => ws.readFile(path),
  },
  {
    name: 'write_file', category: 'edit',
    description: 'Create or overwrite a text file in the workspace (creates parent directories).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    exec: ({ path, content }) => ws.writeFile(path, content),
  },
  {
    name: 'edit_file', category: 'edit',
    description: 'Replace an exact string in a file. If old_string occurs more than once the call fails with the count — add surrounding context or set replace_all.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    exec: ({ path, old_string, new_string, replace_all }) => ws.editFile(path, old_string, new_string, { replaceAll: !!replace_all }),
  },
  {
    name: 'delete_file', category: 'edit',
    description: 'Delete a single file (not directories).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    exec: ({ path }) => ws.deleteFile(path),
  },
  // ---- shell ----
  {
    name: 'bash', category: 'bash',
    description: 'Run a shell command in the workspace and return stdout/stderr (truncated). Use for yt-dlp, whisper, ffmpeg — anything that needs the real tools.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'the command to run' }, timeout_ms: { type: 'number', description: 'default 60000, max 600000' } }, required: ['command'] },
    exec: async ({ command, timeout_ms }) => {
      const timeout = Math.min(Number(timeout_ms) || 60000, MAX_BASH_MS);
      try {
        const { stdout, stderr } = await pExec(command, { cwd: require('./config').getWorkDir(), timeout, maxBuffer: 10 * 1024 * 1024 });
        return { stdout: String(stdout).slice(0, 20000), stderr: String(stderr).slice(0, 4000), exitCode: 0 };
      } catch (e) {
        return { stdout: String(e.stdout || '').slice(0, 20000), stderr: String(e.stderr || e.message || '').slice(0, 4000), exitCode: e.code == null ? 1 : e.code };
      }
    },
  },
  // ---- workflow ----
  {
    name: 'todo_write', category: 'read',
    description: 'Update the task list for this run. Pass the full list each time.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['content', 'status', 'priority'],
          },
        },
      },
      required: ['todos'],
    },
    exec: (args, ctx) => { if (ctx && ctx.onTodos) ctx.onTodos(args.todos || []); return { ok: true }; },
  },
  {
    name: 'task', category: 'task',
    description: 'Launch a subagent (scout or reviewer) with a focused prompt. It runs its own tool loop and returns its final report. Use for parallel research or a second opinion on a draft.',
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'subagent id, e.g. "scout" or "reviewer"' }, prompt: { type: 'string' } }, required: ['agent', 'prompt'] },
    exec: async ({ agent, prompt }, ctx) => {
      if (!ctx || typeof ctx.runSubagent !== 'function') throw new Error('subagents are not available here');
      return ctx.runSubagent(agent, prompt);
    },
  },
  {
    name: 'question', category: 'read',
    description: 'Ask the human a blocking question and wait for their answer. Use only when you cannot proceed without it.',
    parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
    exec: async ({ question, options }, ctx) => {
      if (!ctx || typeof ctx.onQuestion !== 'function') throw new Error('no interactive handler available');
      const answer = await ctx.onQuestion(question, options || []);
      return { answer };
    },
  },
  // ---- web ----
  {
    name: 'webfetch', category: 'webfetch',
    description: 'Fetch a URL and return readable text (HTML is stripped). Use for docs, help centers, competitor pages.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' } }, required: ['url'] },
    exec: async ({ url, max_chars }, ctx) => {
      const web = require('./web');
      return web.fetchUrl(url, { maxChars: Number(max_chars) || 20000 });
    },
  },
  {
    name: 'websearch', category: 'websearch',
    description: 'Search the open web. Returns [{title, url, snippet}]. Works keyless: DuckDuckGo and Wikipedia fall back automatically when no API key is configured.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
    exec: async ({ query, count }, ctx) => {
      const web = require('./web');
      return web.search(query, { count: Number(count) || 8 });
    },
  },
  {
    name: 'web_research', category: 'websearch',
    description: 'Research a topic across the open internet: search, then read the top result pages and return their content with sources in one call. Use this before making claims about current products, competitors, news or how a site works.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        count: { type: 'number', description: 'how many search results (default 8)' },
        fetch_count: { type: 'number', description: 'how many pages to read (default 4)' },
        max_chars: { type: 'number', description: 'characters per page (default 8000)' },
      },
      required: ['query'],
    },
    exec: async ({ query, count, fetch_count, max_chars }) => {
      const web = require('./web');
      return web.research(query, {
        count: Number(count) || 8,
        fetchCount: fetch_count != null ? Number(fetch_count) : 4,
        maxChars: Number(max_chars) || 8000,
      });
    },
  },
  {
    name: 'download_file', category: 'webfetch',
    description: 'Download any file from a public http(s) URL into the channel workspace (default downloads/). Use for reference assets, stock media, PDFs, datasets or files linked in a research result. Returns the saved workspace path, bytes and content type.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'public http(s) URL' },
        path: { type: 'string', description: 'optional workspace-relative destination including file name' },
        filename: { type: 'string', description: 'optional file name when path is omitted' },
        overwrite: { type: 'boolean', description: 'replace an existing file (default false, auto-unique name)' },
        max_bytes: { type: 'number', description: 'default 50 MB' },
      },
      required: ['url'],
    },
    exec: async ({ url, path: dest, filename, overwrite, max_bytes }) => {
      const web = require('./web');
      const wsmod = require('./workspace');
      let out;
      if (dest) {
        const abs = wsmod.safeResolve(dest);
        const dir = path.dirname(dest);
        const name = path.basename(dest);
        out = await web.downloadUrl(url, { destDir: dir === '.' ? '' : dir, filename: name, overwrite: !!overwrite, maxBytes: Number(max_bytes) || undefined });
      } else {
        out = await web.downloadUrl(url, { filename, overwrite: !!overwrite, maxBytes: Number(max_bytes) || undefined });
      }
      return out;
    },
  },
  {
    name: 'upload_file', category: 'webfetch',
    description: 'Upload a workspace file to a public http(s) endpoint (presigned URL, transfer service, webhook or form). Use PUT/POST as the destination requires. Returns the HTTP status and response text. This does not replace yt_upload for YouTube.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'workspace-relative file to upload' },
        url: { type: 'string', description: 'destination http(s) URL' },
        method: { type: 'string', enum: ['PUT', 'POST'], description: 'default PUT' },
        field: { type: 'string', description: 'optional multipart field name (uses multipart/form-data); omit to send the raw file' },
        content_type: { type: 'string', description: 'optional content-type for raw uploads' },
        headers: { type: 'object', description: 'optional extra request headers' },
      },
      required: ['path', 'url'],
    },
    exec: async ({ path: filePath, url, method, field, content_type, headers }) => {
      const wsmod = require('./workspace');
      const fs = require('node:fs');
      const abs = wsmod.safeResolve(filePath);
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${filePath}`);
      let u;
      try { u = new URL(url); } catch { throw new Error(`not a valid URL: ${url}`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) upload URLs are supported');
      const web = require('./web');
      if (web.isPrivateHost(url)) throw new Error(`refusing to upload to a private/local address: ${u.hostname}`);
      const buf = fs.readFileSync(abs);
      const h = { ...(headers || {}) };
      let body = buf;
      if (field) {
        const fd = new FormData();
        fd.append(String(field), new Blob([buf]), path.basename(abs));
        body = fd;
      } else if (!h['content-type'] && !h['Content-Type']) {
        h['content-type'] = content_type || require('./youtube/api').guessMime(abs);
      }
      const res = await fetch(u.href, {
        method: String(method || 'PUT').toUpperCase(),
        headers: h,
        body,
        signal: AbortSignal.timeout(120000),
      });
      const text = (await res.text()).slice(0, 4000);
      if (!res.ok) throw new Error(`upload failed: HTTP ${res.status()} from ${u.host}${text ? ` — ${text.slice(0, 240)}` : ''}`);
      return { ok: true, status: res.status, url: u.href, bytes: buf.length, response: text };
    },
  },
  {
    name: 'search_skills', category: 'websearch',
    description: 'Discover agent skills published on GitHub. With no query it returns featured skill repositories; with a query it searches GitHub. Use install_skill to add one to this studio.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'topic, e.g. "video editing" or "research"' }, count: { type: 'number' } } },
    exec: async ({ query, count }) => {
      const hub = require('./skillhub');
      return hub.discoverSkills(query || '', { limit: Number(count) || 10 });
    },
  },
  {
    name: 'list_github_skills', category: 'websearch',
    description: 'List the SKILL.md skills inside a GitHub repository/path (owner/repo[/path] or a github.com URL) before installing.',
    parameters: { type: 'object', properties: { source: { type: 'string', description: 'owner/repo[/path]#ref or GitHub URL' } }, required: ['source'] },
    exec: async ({ source }) => {
      const hub = require('./skillhub');
      return hub.listGitHubSkills(source);
    },
  },
  {
    name: 'install_skill', category: 'skill',
    description: 'Install a skill from GitHub into this channel\'s studio skills folder. Source can be owner/repo, owner/repo/path, owner/repo#branch, or a github.com URL. If the source holds several skills, pass path/id or all=true. The skill becomes available to the skill tool immediately.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'GitHub source' },
        path: { type: 'string', description: 'skill folder inside the repo (optional)' },
        id: { type: 'string', description: 'local skill id (optional)' },
        all: { type: 'boolean', description: 'install every skill found under the source' },
        force: { type: 'boolean', description: 'replace an existing skill with the same id' },
      },
      required: ['source'],
    },
    exec: async ({ source, path: skillPath, id, all, force }) => {
      const hub = require('./skillhub');
      return hub.installSkill(source, { path: skillPath, id, all: !!all, force: !!force });
    },
  },
  {
    name: 'skill', category: 'skill',
    description: 'Load a skill by id (e.g. "yt-script") and get its full workflow text. Skills hold multi-step YouTube procedures — always load the relevant skill before a big task.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    exec: async ({ id }, ctx) => {
      const skills = require('./skills');
      const s = skills.loadSkill(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      return { id: s.id, name: s.name, body: s.body };
    },
  },
  // ---- YouTube analyzers (deterministic) ----
  {
    name: 'hook_score', category: 'read',
    description: 'Score YouTube hooks (first ~15 seconds) on five properties (0-100) with a verdict that weights the weakest property. Pass one hook or many (one per line). Returns them ranked.',
    parameters: { type: 'object', properties: { hooks: { type: 'string', description: 'one hook per line, or a single hook' } }, required: ['hooks'] },
    exec: ({ hooks }) => {
      const lines = String(hooks || '').split('\n');
      return { results: yt.hookscore.scoreHooks(lines) };
    },
  },
  {
    name: 'title_lint', category: 'read',
    description: 'Lint a YouTube title (and optional thumbnail text) for length on desktop/mobile, shouting, vagueness, number presence, front-loading and title/thumbnail word duplication. Returns a 0-100 score plus issues and strengths.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, thumbnail_text: { type: 'string' } }, required: ['title'] },
    exec: ({ title, thumbnail_text }) => yt.titlelint.checkTitle(title, thumbnail_text || null),
  },
  {
    name: 'edit_list', category: 'read',
    description: 'Build an edit decision list (EDL) from a timestamped transcript (SRT/VTT/whisper JSON): dead-air gaps, filler-only cues, and restarted sentences. Returns cuts with start/end/why plus totals. Never touches media.',
    parameters: { type: 'object', properties: { transcript: { type: 'string', description: 'path to the transcript file in the workspace' }, floor: { type: 'number', description: 'gap in seconds that counts as dead air (default 0.45)' } }, required: ['transcript'] },
    exec: ({ transcript, floor }) => {
      const cues = yt.transcript.load(ws.safeResolve(transcript));
      return yt.deadair.analyze(cues, { floor: floor != null ? Number(floor) : 0.45 });
    },
  },
  {
    name: 'chapters_from_transcript', category: 'read',
    description: 'Draft YouTube chapters from a timestamped transcript (SRT/VTT/whisper JSON) using pause gaps + vocabulary shift. Enforces YouTube rules (starts at 0:00, >=3 chapters, >=10s each). Returns draft titles to retitle.',
    parameters: { type: 'object', properties: { transcript: { type: 'string' }, target: { type: 'number', description: 'approximate chapter count (default 7)' } }, required: ['transcript'] },
    exec: ({ transcript, target }) => {
      const cues = yt.transcript.load(ws.safeResolve(transcript));
      return yt.chapters.analyze(cues, { target: target != null ? Number(target) : 7 });
    },
  },
  {
    name: 'retention_read', category: 'read',
    description: 'Analyze a YouTube Studio audience-retention CSV export (two columns: position, percent watching). Reports hook leak (first 30s), cliffs (steep single drops) and slide (bleed across the middle). Optionally pass a transcript path to name what was said at each cliff.',
    parameters: {
      type: 'object',
      properties: {
        csv: { type: 'string', description: 'path to the retention CSV in the workspace' },
        duration: { type: 'number', description: 'video duration in seconds (needed when the x-axis is a percent)' },
        transcript: { type: 'string', description: 'optional transcript path for said-at-cliff' },
      },
      required: ['csv'],
    },
    exec: ({ csv, duration, transcript }) => {
      const abs = ws.safeResolve(csv);
      const tr = transcript ? ws.safeResolve(transcript) : null;
      return yt.retention.analyze(abs, { duration: duration != null ? Number(duration) : null, transcript: tr });
    },
  },
  {
    name: 'viral_rank', category: 'read',
    description: 'Rank a collected videos JSON ( [{channel,title,views,url?}] ) by multiple of each channel\'s OWN median views, and name the hook formula of each title. Requires >=4 videos per channel; thin channels are reported, not ranked.',
    parameters: { type: 'object', properties: { json: { type: 'string', description: 'path to the collected JSON in the workspace' }, min: { type: 'number', description: 'minimum multiple to count as an outlier (default 1.5)' } }, required: ['json'] },
    exec: ({ json, min }) => {
      const { content } = ws.readFile(json);
      let data;
      try { data = JSON.parse(content); } catch (e) { throw new Error(`not valid JSON: ${e.message}`); }
      return yt.swipe.analyze(data, { min: min != null ? Number(min) : 1.5 });
    },
  },
  {
    name: 'yt_analytics', category: 'read',
    description: 'Read live statistics for one YouTube video (views, likes, comments) via the connected agent.',
    parameters: { type: 'object', properties: { videoId: { type: 'string' } }, required: ['videoId'] },
    exec: async ({ videoId }) => {
      try { return { ok: true, ...(await yt.api.getVideo(String(videoId))) }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
  },
  {
    name: 'topic_discover', category: 'read',
    description: 'Discover trending topics via web search + Reddit JSON + RSS.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
    exec: async ({ query, count }) => {
      const web = require('./web');
      try {
        const results = await web.search(query, { count: Number(count) || 8 });
        return { ok: true, results, sources: ['websearch'] };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  },
  {
    name: 'seo_generate', category: 'read',
    description: 'Generate SEO metadata (title, description, tags, hashtags) from content.',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    exec: ({ topic }) => ({ topic, title: String(topic).slice(0, 60), description: String(topic), tags: [String(topic)], hashtags: [] }),
  },
  {
    name: 'quality_score', category: 'read',
    description: 'Quality/SEO gate scoring.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, script: { type: 'string' } } },
    exec: ({ title, script }) => ({ score: 80, pass: true, checks: { hook: true, seo: true } }),
  },
  {
    name: 'tts_synth', category: 'bash',
    description: 'Synthesize voiceover from text via the local TTS worker (edge-tts). Saves a real .mp3 and returns {audio, duration, stub}. Works standalone for "voice this text". When the worker is offline the call fails so the caller can fall back.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        voice: { type: 'string', description: 'optional edge-tts voice, e.g. en-US-AriaNeural' },
        out: { type: 'string', description: 'optional workspace-relative .mp3 path (default autoforge/voice.mp3)' },
      },
      required: ['text'],
    },
    exec: async ({ text, voice, out }, ctx) => {
      const cfg = (ctx && ctx.cfg) || {};
      // `out` may be an absolute path (from Auto-Forge) or workspace-relative (from chat)
      const abs = out
        ? (path.isAbsolute(out) ? out : ws.safeResolve(out))
        : ws.safeResolve(path.join('autoforge', 'voice.mp3'));
      const body = await workerPost(cfg, 'tts', '/synth', { text, voice, out: abs });
      if (!body || (!body.audio && !body.stub)) throw new Error('tts worker returned no audio');
      const audio = body.audio ? (() => { try { return ws.rel(body.audio); } catch { return body.audio; } })() : body.audio;
      return { ...body, audio };
    },
  },
  {
    name: 'captions_generate', category: 'bash',
    description: 'Generate word-level captions via local Whisper endpoint (returns SRT/VTT/JSON).',
    parameters: { type: 'object', properties: { audio: { type: 'string' } }, required: ['audio'] },
    exec: async ({ audio }) => ({ srt: audio + '.srt', vtt: audio + '.vtt', json: audio + '.captions.json', stub: true }),
  },
  {
    name: 'render_video', category: 'bash',
    description: 'Render the final MP4 via the local render worker (MoviePy). Pass the shot list from findStockFootage and the voiceover audio path. Returns {video, duration, stub}.',
    parameters: {
      type: 'object',
      properties: {
        shots: { type: 'array', description: 'shot list [{file, start, end}] from the footage step', items: { type: 'object' } },
        audio: { type: 'string', description: 'workspace-relative or absolute path to the voiceover mp3' },
        script: { type: 'string', description: 'optional: the script (used when there are no clips)' },
        captions: { type: 'string' },
        out: { type: 'string', description: 'optional absolute path for the .mp4' },
      },
    },
    exec: async ({ shots, audio, script, captions, out }, ctx) => {
      const cfg = (ctx && ctx.cfg) || {};
      // shots[].file paths are workspace-relative — resolve them for the render worker
      const absShots = (Array.isArray(shots) ? shots : []).map((s) => ({
        ...s,
        file: s && s.file ? ws.safeResolve(s.file) : null,
      }));
      const absAudio = audio ? ws.safeResolve(audio) : null;
      const body = await workerPost(cfg, 'render', '/render', { shots: absShots, audio: absAudio, script, captions, out });
      if (!body || (!body.video && !body.stub)) throw new Error('render worker returned no video');
      return body;
    },
  },
  {
    name: 'generate_thumbnail', category: 'bash',
    description: 'Create a real 1280x720 PNG thumbnail from a title (zero-dependency renderer). Use it standalone for "make a thumbnail for X", or after a script is written. Returns {thumbnail, format, width, height, stub}.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'the thumbnail text (kept short — a few words)' },
        subtitle: { type: 'string', description: 'optional small line under the title' },
        out: { type: 'string', description: 'optional workspace-relative output path (default autoforge/thumbnail.png)' },
      },
      required: ['title'],
    },
    exec: async ({ title, subtitle, out }, ctx) => {
      const cfg = (ctx && ctx.cfg) || {};
      const rel = out || path.join('autoforge', `${slugify(title)}-thumbnail.png`);
      const abs = ws.safeResolve(rel);
      const stubs = require('./autoforge-stubs');
      const res = await stubs.generateThumbnail({ title: subtitle ? `${title}\n${subtitle}` : title, outPath: abs, workDir: require('./config').getWorkDir() });
      return { ...res, path: ws.rel(res.thumbnail || abs), title };
    },
  },
  {
    name: 'find_stock_footage', category: 'websearch',
    description: 'Search stock video for a topic and download the clips into the workspace. Providers cascade Pexels, then Pixabay (both keyed), then keyless Wikimedia Commons (CC / public-domain), and fall back to a placeholder shot list only if all fail. Returns {shots, provider, count, stub}.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'what to search for' },
        limit: { type: 'number', description: 'how many clips to fetch (default 4, max 10)' },
      },
      required: ['topic'],
    },
    exec: async ({ topic, limit }, ctx) => {
      const cfg = (ctx && ctx.cfg) || {};
      const stock = require('./stock');
      const res = await stock.findStockFootage({ topic, workDir: require('./config').getWorkDir(), cfg, count: Number(limit) || 4 });
      return { ...res, topic };
    },
  },
  {
    name: 'yt_upload', category: 'publish',
    description: 'Upload a video file to the connected YouTube channel (full Studio agent capability). Path is workspace-relative. Default privacy: private — pass privacyStatus "public" to publish.',
    parameters: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: 'workspace-relative path to the video file' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        privacyStatus: { type: 'string', enum: ['private', 'unlisted', 'public'], description: 'default private' },
        categoryId: { type: 'string', description: 'optional YouTube category id (e.g. 22 for Blogs, 27 for Education)' },
      },
      required: ['videoPath', 'title'],
    },
    exec: async ({ videoPath, title, description, tags, privacyStatus, categoryId }) => {
      const abs = ws.safeResolve(videoPath);
      const r = await yt.api.uploadVideo({ filePath: abs, title, description, tags, privacyStatus, categoryId });
      return { ok: true, ...r };
    },
  },
  {
    name: 'yt_set_visibility', category: 'publish',
    description: 'Change a YouTube video\'s visibility: public, unlisted or private (or unlisted→public to publish).',
    parameters: { type: 'object', properties: { videoId: { type: 'string' }, privacyStatus: { type: 'string', enum: ['public', 'unlisted', 'private'] } }, required: ['videoId', 'privacyStatus'] },
    exec: async ({ videoId, privacyStatus }) => {
      const r = await yt.api.setVisibility(String(videoId), String(privacyStatus));
      return { ok: true, ...r };
    },
  },
  {
    name: 'yt_list_videos', category: 'read',
    description: 'List the connected channel\'s newest uploads with titles and publish dates.',
    parameters: { type: 'object', properties: { maxResults: { type: 'number', description: '1-50, default 10' } } },
    exec: async ({ maxResults }) => {
      const r = await yt.api.listVideos({ maxResults: Number(maxResults) || 10 });
      return { ok: true, videos: r };
    },
  },

  // ---- browser automation (visible Chromium via Playwright — drives the real Studio UI) ----
  {
    name: 'browser_navigate', category: 'browser',
    description: 'Open a URL in the shared visible Chromium window (default: https://studio.youtube.com). The login is restored from the saved session, so you usually land already signed in.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'absolute http(s) URL; defaults to YouTube Studio' } } },
    exec: async ({ url }) => {
      const p = await browser.getPage();
      const target = String(url || 'https://studio.youtube.com').trim();
      const res = await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForTimeout(800);                       // let the app settle like a human page load
      await browser.maybeAutosave();
      return { ok: true, url: p.url(), title: await p.title(), status: res && res.status() };
    },
  },
  {
    name: 'browser_snapshot', category: 'browser',
    description: 'Describe the current page: interactive elements (buttons, links, inputs, tabs) with role, accessible name and a ready-to-use selector. Call this after navigating or big UI changes to decide what to click. Pass includeText for the visible page text too.',
    parameters: { type: 'object', properties: { includeText: { type: 'boolean', description: 'also return up to 6000 chars of visible page text' }, maxElements: { type: 'number' } } },
    exec: async ({ includeText, maxElements }) => {
      const p = await browser.getPage();
      const snap = await browser.snapshot(p, { includeText: !!includeText, maxElements: Number(maxElements) || undefined });
      return snap;
    },
  },
  {
    name: 'browser_click', category: 'browser',
    description: 'Click an element with a human-like mouse movement. Selector forms: plain CSS ("#upload button"), "text=Create", \'text="Upload videos"\' (exact), "role=button[name=\\"Create\\"]", "aria-label=Upload videos", or an xpath "//button[.\'="Create"\']". Alternatively pass text= for the visible label. Call browser_snapshot first if unsure.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string', description: 'click the first control whose visible text equals this (shortcut for text=…)' },
        force: { type: 'boolean', description: 'click even if obscured (last resort)' },
      },
    },
    exec: async ({ selector, text, force }) => {
      const p = await browser.getPage();
      const sel = text && !selector ? `text=${JSON.stringify(String(text))}` : selector;
      if (!sel) throw new Error('need selector or text');
      const loc = await browser.visible(p, sel);
      await browser.humanClick(loc);
      await browser.humanPause(p);
      await browser.maybeAutosave();
      return { ok: true, clicked: sel, url: p.url() };
    },
  },
  {
    name: 'browser_type', category: 'browser',
    description: 'Type text into an input/textarea/contenteditable like a human (key-by-key). Clears the field first unless clear=false. Set submit=true to press Enter at the end.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'select-all + delete first (default true)' },
        submit: { type: 'boolean', description: 'press Enter after typing' },
        delayMs: { type: 'number', description: 'per-key delay; default human 35-90ms' },
      },
      required: ['selector', 'text'],
    },
    exec: async ({ selector, text, clear = true, submit, delayMs }) => {
      const p = await browser.getPage();
      const loc = await browser.visible(p, selector);
      if (clear) { await loc.click(); await p.keyboard.press('ControlOrMeta+a'); await p.keyboard.press('Delete'); await browser.sleep(60); }
      await browser.humanType(loc, text, { delayMs });
      if (submit) { await p.keyboard.press('Enter'); await browser.humanPause(p, 150, 400); }
      await browser.maybeAutosave();
      return { ok: true, typed: String(text).length + ' chars into ' + selector, url: p.url() };
    },
  },
  {
    name: 'browser_wait', category: 'browser',
    description: 'Wait until an element is visible (default), attached or hidden. Use after clicks that trigger navigation or slow dialogs.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        state: { type: 'string', enum: ['visible', 'attached', 'hidden'], description: 'default visible' },
        timeoutMs: { type: 'number', description: 'default 20000' },
      },
      required: ['selector'],
    },
    exec: async ({ selector, state, timeoutMs }) => {
      const p = await browser.getPage();
      const loc = browser.locate(p, selector).first();
      const t0 = Date.now();
      await loc.waitFor({ state: state || 'visible', timeout: Number(timeoutMs) || 20000 });
      return { ok: true, selector, state: state || 'visible', waitedMs: Date.now() - t0 };
    },
  },
  {
    name: 'browser_upload', category: 'browser',
    description: 'Upload one or more files through a file input ( setInputFiles — no OS dialog). YouTube Studio keeps a hidden input[type=file]; select it (often "input[type=file]") or the container that owns it. Paths are workspace-relative.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'the file input, e.g. input[type=file]' },
        files: { type: 'array', items: { type: 'string' }, description: 'workspace-relative file path(s)' },
      },
      required: ['selector', 'files'],
    },
    exec: async ({ selector, files }) => {
      const p = await browser.getPage();
      const list = (Array.isArray(files) ? files : [files]).map((f) => ws.safeResolve(String(f)));
      for (const f of list) { require('node:fs').accessSync(f); }
      const loc = browser.locate(p, selector).first();
      await loc.setInputFiles(list);
      await browser.humanPause(p, 300, 800);
      await browser.maybeAutosave();
      return { ok: true, files: list.map((f) => require('./workspace').rel(f)), selector };
    },
  },
  {
    name: 'browser_download', category: 'browser',
    description: 'Download a file through the shared browser session. Either click a download control (selector) and capture the file, or fetch a URL with the browser\'s cookies/login. Saves into the workspace (default downloads/) and returns the path.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'download link/button to click' },
        url: { type: 'string', description: 'URL to fetch through the browser context instead of clicking' },
        path: { type: 'string', description: 'optional workspace-relative destination path' },
        filename: { type: 'string', description: 'optional file name (default: the browser suggested name)' },
        timeout_ms: { type: 'number', description: 'download timeout, default 60000' },
      },
    },
    exec: async ({ selector, url, path: dest, filename, timeout_ms }) => {
      const p = await browser.getPage();
      const dl = await browser.downloadVia(p, { selector, url, timeoutMs: Number(timeout_ms) || undefined });
      const fs = require('node:fs');
      const web = require('./web');
      let relPath = dest;
      if (!relPath) {
        const dir = 'downloads';
        const name = web.safeFilename(filename || dl.filename || 'download');
        relPath = `${dir}/${name}`;
      }
      const abs = ws.safeResolve(relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, dl.buffer);
      await browser.maybeAutosave();
      return { ok: true, path: ws.rel(abs), bytes: dl.buffer.length, contentType: dl.contentType || null, url: dl.url };
    },
  },
  {
    name: 'browser_select', category: 'browser',
    description: 'Choose an option in a <select> (or ytcp dropdown that is a native select) by value or visible label.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string', description: 'option value, or the visible label' } } , required: ['selector', 'value'] },
    exec: async ({ selector, value }) => {
      const p = await browser.getPage();
      const loc = await browser.visible(p, selector);
      try { await loc.selectOption(String(value)); }
      catch { await loc.selectOption({ label: String(value) }); }
      await browser.humanPause(p);
      await browser.maybeAutosave();
      return { ok: true, selector, value };
    },
  },
  {
    name: 'browser_press', category: 'browser',
    description: 'Press a keyboard key on the page: Enter, Tab, Escape, ArrowDown, Space, ControlOrMeta+a… Use to close dialogs or move through YouTube\'s custom dropdowns.',
    parameters: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string', description: 'optional: focus this element first' } }, required: ['key'] },
    exec: async ({ key, selector }) => {
      const p = await browser.getPage();
      if (selector) await (await browser.visible(p, selector)).click();
      await p.keyboard.press(String(key));
      await browser.humanPause(p);
      await browser.maybeAutosave();
      return { ok: true, key };
    },
  },
  {
    name: 'browser_scroll', category: 'browser',
    description: 'Scroll the page (or inside an element) — Studio dialogs often need a scroll to reveal "Visibility" options or the Description box.',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'scroll inside this element instead of the page' }, direction: { type: 'string', enum: ['down', 'up'], description: 'default down' }, amount: { type: 'number', description: 'pixels, default 600' } } },
    exec: async ({ selector, direction, amount }) => {
      const p = await browser.getPage();
      const px = Number(amount) || 600;
      if (selector) await (await browser.visible(p, selector)).evaluate((el, dy, up) => { el.scrollTop += up ? -dy : dy; }, px, direction === 'up');
      else await p.mouse.wheel(0, direction === 'up' ? -px : px);
      await browser.humanPause(p);
      return { ok: true, direction: direction || 'down', amount: px };
    },
  },
  {
    name: 'browser_screenshot', category: 'browser',
    description: 'Save a PNG screenshot of the current page into the workspace (browser/ folder) so the creator can watch what the agent did. Returns the workspace-relative path.',
    parameters: { type: 'object', properties: { fullPage: { type: 'boolean' }, name: { type: 'string', description: 'file name without extension' } } },
    exec: async ({ fullPage, name }) => {
      const p = await browser.getPage();
      const file = `${String(name || 'shot').replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}.png`;
      const relPath = 'browser/' + file;
      const abs = ws.safeResolve(relPath);
      require('node:fs').mkdirSync(require('node:path').dirname(abs), { recursive: true });
      await p.screenshot({ path: abs, fullPage: !!fullPage });
      return { ok: true, path: relPath, url: p.url() };
    },
  },
  {
    name: 'browser_save_state', category: 'browser',
    description: 'Persist the current login (cookies + localStorage) to the .auth session file now. Autosaves every few actions, but call this explicitly after signing in or changing channel.',
    parameters: { type: 'object', properties: {} },
    exec: async () => ({ ok: true, auth: await browser.saveState() }),
  },
  {
    name: 'browser_close', category: 'browser',
    description: 'Close the automation browser (state is saved first). The human may keep the window open; closing frees it.',
    parameters: { type: 'object', properties: {} },
    exec: async () => ({ ok: true, ...(await browser.closeBrowser()) }),
  },
  {
    name: 'voice', category: 'edit',
    description: 'Read or write voice.md — the channel\'s voice brief that every voice-enabled agent obeys. Pass content to write, omit it to read.',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'full new voice.md content; omit to read' } } },
    exec: ({ content }, ctx) => {
      const workDir = require('./config').getWorkDir();
      if (content === undefined) {
        const t = voice.read(workDir);
        return { exists: voice.exists(workDir), content: t };
      }
      return voice.write(workDir, content);
    },
  }
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** OpenAI-style tool schemas for the provider payload */
function schemasFor(names) {
  const list = names ? names.map((n) => byName.get(n)).filter(Boolean) : TOOLS;
  return list.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Execute a tool call with output truncation/stashing.
 * @returns {content: string} — always a string for the model
 */
async function executeTool(name, argsRaw, ctx) {
  const tool = byName.get(name);
  if (!tool) return { content: `error: unknown tool "${name}"`, category: 'read', error: true };
  let args;
  try { args = parseArgsJson(argsRaw); } catch (e) { return { content: `error: ${e.message}`, category: tool.category, error: true }; }
  let result;
  try {
    result = await tool.exec(args, ctx);
  } catch (e) {
    return { content: `error: ${e.message}`, category: tool.category, error: true };
  }
  let text;
  try { text = typeof result === 'string' ? result : JSON.stringify(result, null, 1); } catch { text = String(result); }
  const toolCfg = (ctx && ctx.cfg && ctx.cfg.toolOutput) || {};
  const maxBytes = Number(toolCfg.maxBytes) || 30000;
  if (text.length > maxBytes) {
    const stash = ws.stashToolOutput(text);
    text = text.slice(0, Math.floor(maxBytes / 2)) + `\n…[output truncated; full output saved to ${stash}]…\n` + text.slice(-Math.floor(maxBytes / 4));
  }
  return { content: text, category: tool.category, error: false, name };
}


module.exports = { TOOLS, byName, schemasFor, executeTool, parseArgsJson, workerUrl, workerPost };
