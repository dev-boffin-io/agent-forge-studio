'use strict';

// Auto-Forge — the autonomous YouTube creator. A deterministic state machine that drives the
// full pipeline for one idea:
//
//   idea → script → voice → footage → render → thumbnail → [upload gate] → upload
//
// Each content step reuses the real infrastructure (the LLM, the deterministic tools, the
// yt-script skill, the workspace) and falls back to a clearly-marked placeholder (see
// autoforge-stubs.js) when a capability is not automated yet. Progress is streamed to the UI as
// an `autoforge` event: { step, total, id, label, status }. A failure halts the machine before
// the upload gate. Upload NEVER runs unless the human answers the question with exactly 'Yes,
// upload it!'.
//
// Zero new dependencies.

const path = require('node:path');
const log = require('./log');
const skills = require('./skills');
const tools = require('./tools');
const llm = require('./llm');
const ws = require('./workspace');
const stubs = require('./autoforge-stubs');
const { getWorkDir } = require('./config');

const TOTAL = 7;

/** The ordered pipeline. `skill` marks steps that load a skill body into the prompt. */
const STEPS = [
  { id: 'idea', label: 'Researching the idea' },
  { id: 'script', label: 'Writing the script', skill: 'yt-script' },
  { id: 'voice', label: 'Generating voiceover' },
  { id: 'footage', label: 'Gathering stock footage' },
  { id: 'render', label: 'Rendering the video' },
  { id: 'thumbnail', label: 'Creating the thumbnail' },
  { id: 'upload', label: 'Uploading to YouTube', gated: true },
];

const UPLOAD_QUESTION = 'Video and thumbnail are ready. Do you want to upload it to YouTube now?';
const UPLOAD_YES = 'Yes, upload it!';
const UPLOAD_NO = 'No, let me review first';

/** slugify an idea into a safe folder name */
function slugify(text) {
  return String(text || 'video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'video';
}

/**
 * Emit a step state transition.
 * @param {(event, data)=>void} emit
 * @param {number} index  0-based step index
 * @param {'start'|'done'|'skipped'|'error'} status
 */
function stepEvent(emit, index, status, extra = {}) {
  const step = STEPS[index];
  emit('autoforge', {
    step: index + 1,
    total: TOTAL,
    id: step.id,
    label: step.label,
    status,
    ...extra,
  });
}

/**
 * Run the full Auto-Forge pipeline for one idea.
 *
 * @param {object} opts
 * @param {string} opts.idea        the seed idea / topic
 * @param {object} opts.cfg         resolved config (model, endpoint, …)
 * @param {(event,data)=>void} opts.emit   SSE sink
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onQuestion]  async (question, options) => answer  — interactive gate
 * @param {object} [opts.deps]      injectable dependencies (for tests)
 * @returns {{ok:boolean, failedStep?:string, artifacts?:object, uploaded?:object}}
 */
async function runAutoForge(opts) {
  const {
    idea, cfg, emit, signal,
    onQuestion,
    deps = {},
  } = opts;

  const sendChat = deps.sendChat || llm.sendChat;
  const resolveProvider = deps.resolveProvider || llm.resolveProvider;
  const loadSkill = deps.loadSkill || skills.loadSkill;
  const executeTool = deps.executeTool || tools.executeTool;
  const findStockFootage = deps.findStockFootage || stubs.findStockFootage;
  const generateThumbnail = deps.generateThumbnail || stubs.generateThumbnail;
  const writeFile = deps.writeFile || ((p, c) => ws.writeFile(p, c));
  const workDir = deps.workDir || getWorkDir();

  if (!idea || !String(idea).trim()) throw new Error('autoforge: an idea is required');
  const model = cfg && cfg.model;
  if (!model) throw new Error('no model selected — open Providers and pick one');
  const provider = resolveProvider(cfg, cfg.providerId || cfg.defaultProvider || 'default');

  const slug = slugify(idea);
  const dir = path.join('autoforge', slug);
  const out = (name) => path.join(dir, name);
  const artifacts = {};

  emit('autoforge', { step: 0, total: TOTAL, id: 'start', label: 'Auto-Forge started', status: 'start', idea: String(idea).trim(), slug });

  /** run one step body with uniform error handling; returns [ok, value] */
  const guard = (index, fn) => async () => {
    stepEvent(emit, index, 'start');
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (e) {
      log.error('autoforge', `step "${STEPS[index].id}" failed`, e);
      stepEvent(emit, index, 'error', { error: e.message || String(e) });
      return { ok: false, error: e };
    }
  };

  // ---- Step 1: idea (research) -------------------------------------------------------------
  {
    const r = await guard(0, async () => {
      let research = '';
      try {
        const res = await executeTool('topic_discover', JSON.stringify({ query: String(idea), count: 6 }), { cfg });
        research = res && res.content ? res.content : '';
      } catch (e) { log.warn('autoforge', 'topic research unavailable; continuing', e); }
      const brief = `# Auto-Forge brief\n\n**Idea:** ${String(idea).trim()}\n\n## Research notes\n${research || '(no research provider configured — proceeding with the idea as given)'}\n`;
      writeFile(out('brief.md'), brief);
      artifacts.brief = out('brief.md');
      return { brief: artifacts.brief, hasResearch: !!research };
    })();
    if (!r.ok) return { ok: false, failedStep: 'idea' };
    stepEvent(emit, 0, 'done', { detail: r.value.brief });
  }

  // ---- Step 2: script (real — LLM + hook_score + yt-script skill) ----------------------------
  let script = '';
  {
    const r = await guard(1, async () => {
      const skill = loadSkill('yt-script');
      const system = [
        'You are the YouTube script writer for Auto-Forge. Follow the skill workflow exactly.',
        skill && skill.body ? `\n# Skill: yt-script\n${skill.body}` : '',
      ].join('\n');
      const res = await sendChat(provider, {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Write a complete video script for this idea:\n\n${String(idea).trim()}\n\nReturn only the script, beat by beat, with [ON SCREEN: ...] cues and a marked hook.` },
        ],
        temperature: (cfg && cfg.temperature != null) ? cfg.temperature : 0.6,
        numCtx: Number(cfg && cfg.numCtx) || 0,
        timeoutMs: Number(cfg && cfg.requestTimeoutMs) || undefined,
        signal,
        onToken: (t) => emit('token', { text: t }),
      });
      const text = (res && res.text) || '';
      if (!text.trim()) throw new Error('the model returned an empty script');
      writeFile(out('script.md'), text.trim() + '\n');
      artifacts.script = out('script.md');
      script = text.trim();

      // score the first line as the hook (best-effort; never fatal)
      let hook = null;
      try {
        const firstLine = (script.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '');
        const hs = await executeTool('hook_score', JSON.stringify({ hooks: firstLine }), { cfg });
        hook = hs && hs.content ? hs.content : null;
        if (hook) writeFile(out('hookscore.json'), hook.endsWith('\n') ? hook : hook + '\n');
      } catch (e) { log.warn('autoforge', 'hook_score failed; continuing', e); }
      return { script: artifacts.script, hook };
    })();
    if (!r.ok) return { ok: false, failedStep: 'script', artifacts };
    stepEvent(emit, 1, 'done', { detail: r.value.script });
  }

  // ---- Step 3: voice (TTS worker, or stub) ---------------------------------------------------
  {
    const r = await guard(2, async () => {
      let audio = null;
      try {
        const outAbs = ws.safeResolve(out('voice.mp3'));
        const res = await executeTool('tts_synth', JSON.stringify({ text: script.slice(0, 4000), out: outAbs }), { cfg });
        const body = res && res.content ? res.content : '';
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.audio && !parsed.stub) {
            audio = parsed.audio;
            // the worker may write outside the workspace; expose it workspace-relative
            try { audio = ws.rel(parsed.audio); } catch { /* keep absolute */ }
          }
        } catch { /* worker returned text */ }
      } catch (e) { log.warn('autoforge', 'tts worker unavailable', e); }
      return { audio, stub: !audio };
    })();
    if (!r.ok) return { ok: false, failedStep: 'voice', artifacts };
    if (r.value.stub) stepEvent(emit, 2, 'skipped', { detail: '⚠ placeholder (TTS worker offline — start workers/tts on :8101)' });
    else { artifacts.voice = r.value.audio; stepEvent(emit, 2, 'done', { detail: r.value.audio }); }
  }

  // ---- Step 4: stock footage (Pexels download, or stub) -------------------------------------
  let shots = [];
  {
    const r = await guard(3, async () => findStockFootage({ topic: String(idea).trim(), workDir, cfg }))();
    if (!r.ok) return { ok: false, failedStep: 'footage', artifacts };
    shots = Array.isArray(r.value.shots) ? r.value.shots : [];
    writeFile(out('shots.json'), JSON.stringify(shots, null, 2) + '\n');
    artifacts.shots = out('shots.json');
    stepEvent(emit, 3, r.value.stub ? 'skipped' : 'done', {
      detail: r.value.stub ? `⚠ placeholder (${r.value.reason || 'no stock provider'})` : `${r.value.count || shots.length} clips from ${r.value.provider || 'provider'}`,
    });
  }

  // ---- Step 5: render (render worker, or stub) ----------------------------------------------
  {
    const r = await guard(4, async () => {
      let video = null;
      try {
        const res = await executeTool('render_video', JSON.stringify({
          shots,
          audio: artifacts.voice || null,
          script: artifacts.script || null,
          out: ws.safeResolve(out('video.mp4')),
        }), { cfg });
        const body = res && res.content ? res.content : '';
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.video && !parsed.stub) video = parsed.video;
        } catch { /* worker returned text */ }
      } catch (e) { log.warn('autoforge', 'render worker unavailable', e); }
      return { video, stub: !video };
    })();
    if (!r.ok) return { ok: false, failedStep: 'render', artifacts };
    if (r.value.stub) stepEvent(emit, 4, 'skipped', { detail: '⚠ placeholder (render worker offline — start workers/render on :8102)' });
    else { artifacts.video = r.value.video; stepEvent(emit, 4, 'done', { detail: r.value.video }); }
  }

  // ---- Step 6: thumbnail (real PNG) ----------------------------------------------------------
  let title = '';
  {
    const r = await guard(5, async () => {
      // derive a working title from the script's first heading, else the idea
      title = (script.match(/^#\s+(.+)$/m) || [])[1] || String(idea).trim();
      const abs = ws.safeResolve(out('thumbnail.png'));
      const t = await generateThumbnail({ title, outPath: abs, workDir });
      return t;
    })();
    if (!r.ok) return { ok: false, failedStep: 'thumbnail', artifacts };
    artifacts.thumbnail = r.value.thumbnail || out('thumbnail.png');
    stepEvent(emit, 5, r.value.stub ? 'skipped' : 'done', {
      detail: r.value.stub ? `⚠ placeholder (${r.value.reason || 'PNG render failed'})` : r.value.thumbnail,
    });
  }

  // ---- Step 7: upload (GATED) ----------------------------------------------------------------
  // The gate is a blocking question; only an explicit "Yes, upload it!" proceeds.
  let answer = '';
  try {
    answer = onQuestion ? await onQuestion(UPLOAD_QUESTION, [UPLOAD_YES, UPLOAD_NO]) : '';
  } catch (e) {
    log.warn('autoforge', 'upload question failed', e);
    answer = '';
  }

  if (answer !== UPLOAD_YES) {
    log.info('autoforge', `upload declined ("${answer}") — stopping before yt_upload`);
    stepEvent(emit, 6, 'skipped', { detail: answer === UPLOAD_NO ? 'not uploaded — kept for review' : 'not uploaded — no confirmation' });
    emit('autoforge', { step: TOTAL, total: TOTAL, id: 'done', label: 'Auto-Forge finished (not uploaded)', status: 'done', artifacts, uploaded: null });
    return { ok: true, uploaded: null, artifacts };
  }

  // the human said yes — upload, still subject to the publish permission gate
  const r = await guard(6, async () => {
    const videoPath = artifacts.video || out('video.mp4');
    const res = await executeTool('yt_upload', JSON.stringify({
      videoPath,
      title: title || String(idea).trim(),
      description: `Auto-Forge: ${String(idea).trim()}`,
      privacyStatus: 'private',
    }), { cfg });
    let parsed = null;
    try { parsed = JSON.parse(res && res.content ? res.content : '{}'); } catch { /* text */ }
    if (!parsed || parsed.ok === false || parsed.error) {
      throw new Error((parsed && (parsed.error || parsed.message)) || 'yt_upload failed');
    }
    return parsed;
  })();

  if (!r.ok) return { ok: false, failedStep: 'upload', artifacts };
  stepEvent(emit, 6, 'done', { detail: (r.value && (r.value.url || r.value.id)) || 'uploaded' });
  emit('autoforge', { step: TOTAL, total: TOTAL, id: 'done', label: 'Auto-Forge finished', status: 'done', artifacts, uploaded: r.value });
  return { ok: true, uploaded: r.value, artifacts };
}

module.exports = { runAutoForge, STEPS, TOTAL, slugify, UPLOAD_QUESTION, UPLOAD_YES, UPLOAD_NO };
