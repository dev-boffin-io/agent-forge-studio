'use strict';

// Auto-Forge — deterministic pipeline tests. Everything network/disk-heavy is injected so the
// state machine (step order, error halting, the upload gate) can be tested in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAutoForge, STEPS, TOTAL, UPLOAD_QUESTION, UPLOAD_YES, UPLOAD_NO } = require('../lib/autoforge');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'autoforge-')); }

/** minimal deps: no network, files written to a temp dir */
function baseDeps(dir, overrides = {}) {
  const written = {};
  return {
    written,
    deps: {
      workDir: dir,
      resolveProvider: () => ({ id: 'default', type: 'ollama', endpoint: 'http://localhost:11434' }),
      sendChat: async () => ({ text: '# My Hook\n\nThe body of the script.\n' }),
      loadSkill: () => ({ id: 'yt-script', body: 'skill body' }),
      executeTool: async (name) => {
        if (name === 'hook_score') return { content: JSON.stringify({ results: [{ score: 80 }] }) };
        if (name === 'topic_discover') return { content: 'research notes' };
        if (name === 'tts_synth') return { content: JSON.stringify({ audio: 'x.mp3', stub: true }) };
        if (name === 'render_video') return { content: JSON.stringify({ video: 'x.mp4', stub: true }) };
        if (name === 'yt_upload') return { content: JSON.stringify({ ok: true, id: 'VID123', url: 'https://youtu.be/VID123' }) };
        return { content: '{}' };
      },
      findStockFootage: async () => ({ shots: [{ start: 0, end: 5, query: 'x' }], stub: true }),
      generateThumbnail: async ({ outPath }) => ({ thumbnail: outPath, stub: true }),
      writeFile: (p, c) => { written[p] = c; },
      ...overrides,
    },
  };
}

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}

function afEvents(events) { return events.filter((e) => e.event === 'autoforge').map((e) => e.data); }
const STEP_IDS = STEPS.map((s) => s.id);
function stepsCompleted(events) {
  return afEvents(events).filter((e) => e.status === 'done' && STEP_IDS.includes(e.id)).map((e) => e.id);
}

test('autoforge: happy path runs all 7 steps in order and uploads when confirmed', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir);
  const { events, emit } = collect();
  const q = [];
  const onQuestion = async (question, options) => { q.push({ question, options }); return UPLOAD_YES; };

  const res = await runAutoForge({ idea: 'why channels stall', cfg: { model: 'llama3' }, emit, onQuestion, deps });

  assert.equal(res.ok, true);
  assert.ok(res.uploaded, 'uploaded result present');
  assert.deepEqual(stepsCompleted(events), ['idea', 'script', 'upload']);
  // progress steps are numbered 1..7
  const starts = afEvents(events).filter((e) => e.status === 'start' && e.step > 0);
  assert.deepEqual(starts.map((e) => e.step), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(starts[0].total, TOTAL);
  // the upload gate used the exact prompt + options
  assert.equal(q.length, 1);
  assert.equal(q[0].question, UPLOAD_QUESTION);
  assert.deepEqual(q[0].options, [UPLOAD_YES, UPLOAD_NO]);

  // placeholder steps are marked skipped, not failed
  const skipped = afEvents(events).filter((e) => e.status === 'skipped').map((e) => e.id);
  assert.deepEqual(skipped.sort(), ['footage', 'render', 'thumbnail', 'voice'].sort());
});

test('autoforge: declining the gate stops before upload', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir);
  const { events, emit } = collect();
  let uploadCalled = false;
  deps.executeTool = async (name) => {
    if (name === 'yt_upload') { uploadCalled = true; return { content: JSON.stringify({ ok: true }) }; }
    if (name === 'hook_score') return { content: '{}' };
    return { content: '{}' };
  };
  const res = await runAutoForge({ idea: 'x', cfg: { model: 'm' }, emit, onQuestion: async () => UPLOAD_NO, deps });

  assert.equal(res.ok, true);
  assert.equal(res.uploaded, null);
  assert.equal(uploadCalled, false, 'yt_upload must NOT be called when declined');
  const upload = afEvents(events).find((e) => e.id === 'upload' && e.status === 'skipped');
  assert.ok(upload, 'upload step reported skipped');
});

test('autoforge: a failing step halts the machine before upload', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir, {
    sendChat: async () => ({ text: '' }),   // empty script → script step throws
  });
  const { events, emit } = collect();
  let uploadCalled = false;
  const origExecute = deps.executeTool;
  deps.executeTool = async (name, ...rest) => { if (name === 'yt_upload') uploadCalled = true; return origExecute(name, ...rest); };

  const res = await runAutoForge({ idea: 'x', cfg: { model: 'm' }, emit, onQuestion: async () => UPLOAD_YES, deps });

  assert.equal(res.ok, false);
  assert.equal(res.failedStep, 'script');
  assert.equal(uploadCalled, false, 'no upload after a mid-pipeline failure');
  const err = afEvents(events).find((e) => e.status === 'error');
  assert.equal(err.id, 'script');
  // steps after the failure never started
  const startedAfter = afEvents(events).filter((e) => e.status === 'start' && ['voice', 'footage', 'render', 'thumbnail', 'upload'].includes(e.id));
  assert.equal(startedAfter.length, 0, 'nothing after the failed step starts');
});

test('autoforge: missing model is rejected', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir);
  const { emit } = collect();
  await assert.rejects(() => runAutoForge({ idea: 'x', cfg: {}, emit, onQuestion: async () => UPLOAD_YES, deps }), /no model/);
});

test('autoforge: empty idea is rejected', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir);
  const { emit } = collect();
  await assert.rejects(() => runAutoForge({ idea: '   ', cfg: { model: 'm' }, emit, onQuestion: async () => UPLOAD_YES, deps }), /idea is required/);
});

test('autoforge: no answer to the gate means no upload', async () => {
  const dir = tmpDir();
  const { deps } = baseDeps(dir);
  const { events, emit } = collect();
  let uploadCalled = false;
  deps.executeTool = async (name) => { if (name === 'yt_upload') uploadCalled = true; return { content: '{}' }; };
  const res = await runAutoForge({ idea: 'x', cfg: { model: 'm' }, emit, onQuestion: async () => '', deps });
  assert.equal(res.uploaded, null);
  assert.equal(uploadCalled, false);
});

test('autoforge: a hanging script step is bounded by requestTimeoutMs and halts', async () => {
  const dir = tmpDir();
  // simulate the real llm.sendChat: the script step passes timeoutMs, so a hang aborts
  const { deps } = baseDeps(dir, {
    sendChat: (provider, opts) => new Promise((_res, rej) => {
      const ms = opts.timeoutMs || 600000;
      const timer = setTimeout(() => rej(Object.assign(new Error('request timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' })), ms);
      if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(timer); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }),
  });
  const { events, emit } = collect();
  const t0 = Date.now();
  const res = await runAutoForge({ idea: 'x', cfg: { model: 'm', requestTimeoutMs: 100 }, emit, onQuestion: async () => UPLOAD_YES, deps });
  const dt = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.equal(res.failedStep, 'script');
  assert.ok(dt < 3000, `script step should be bounded, took ${dt}ms`);
  const err = afEvents(events).find((e) => e.status === 'error');
  assert.equal(err.id, 'script');
});

test('autoforge: real media outputs (stub:false) mark steps done and flow into render', async () => {
  const dir = tmpDir();
  let renderArgs = null;
  const { deps } = baseDeps(dir, {
    findStockFootage: async () => ({
      stub: false,
      provider: 'pexels',
      count: 2,
      shots: [
        { file: 'autoforge/x/footage/clip-01.mp4', start: 0, end: 5, stub: false },
        { file: 'autoforge/x/footage/clip-02.mp4', start: 5, end: 10, stub: false },
      ],
    }),
    generateThumbnail: async ({ outPath }) => ({ thumbnail: outPath, format: 'png', stub: false }),
  });
  const origExecute = deps.executeTool;
  deps.executeTool = async (name, argsRaw, ctx) => {
    if (name === 'tts_synth') return { content: JSON.stringify({ audio: 'autoforge/x/voice.mp3', duration: 12, stub: false }) };
    if (name === 'render_video') { renderArgs = JSON.parse(argsRaw); return { content: JSON.stringify({ video: 'autoforge/x/video.mp4', duration: 20, stub: false }) }; }
    return origExecute(name, argsRaw, ctx);
  };

  const { events, emit } = collect();
  const res = await runAutoForge({ idea: 'x', cfg: { model: 'm' }, emit, onQuestion: async () => UPLOAD_YES, deps });

  assert.equal(res.ok, true);
  // voice / footage / render / thumbnail all completed for real
  assert.deepEqual(stepsCompleted(events).sort(), ['footage', 'idea', 'render', 'script', 'thumbnail', 'upload', 'voice'].sort());
  // the render tool received the downloaded shot list + the voiceover
  assert.ok(renderArgs, 'render_video was called');
  assert.equal(renderArgs.shots.length, 2);
  assert.equal(renderArgs.shots[0].file, 'autoforge/x/footage/clip-01.mp4');
  assert.equal(renderArgs.audio, 'autoforge/x/voice.mp3');
  // artifacts recorded the real outputs
  assert.equal(res.artifacts.video, 'autoforge/x/video.mp4');
  assert.equal(res.artifacts.voice, 'autoforge/x/voice.mp3');
  assert.match(res.artifacts.thumbnail, /thumbnail\.png$/);
});

// ---- voice / footage / render wiring ----------------------------------------------------------

const { footageQueries } = require('../lib/autoforge');

test('autoforge: short English ideas are searched as-is, no LLM call', async () => {
  let called = false;
  const qs = await footageQueries({ idea: 'coffee brewing', script: '', sendChat: async () => { called = true; return { text: '' }; }, provider: {}, model: 'm' });
  assert.deepEqual(qs, ['coffee brewing']);
  assert.equal(called, false);
});

test('autoforge: a Bengali idea is turned into English footage queries by the model', async () => {
  const sendChat = async () => ({ text: 'Here you go: ["coffee beans", "barista pouring latte", "cafe morning", "বাংলা"]' });
  const qs = await footageQueries({ idea: 'কফি বানানোর সহজ উপায়', script: 'x', sendChat, provider: {}, model: 'm' });
  assert.deepEqual(qs, ['coffee beans', 'barista pouring latte', 'cafe morning']);   // non-ASCII entry dropped
});

test('autoforge: footage queries never come back empty when the model fails', async () => {
  const qs = await footageQueries({ idea: 'কফি', script: '', sendChat: async () => { throw new Error('down'); }, provider: {}, model: 'm' });
  assert.deepEqual(qs, ['cinematic b-roll']);
  const mixed = await footageQueries({ idea: 'কফি brewing guide for beginners at home with a moka pot', script: '', sendChat: async () => ({ text: 'no json' }), provider: {}, model: 'm' });
  assert.ok(mixed.length === 1 && /^[\x20-\x7e]+$/.test(mixed[0]) && mixed[0].length > 3);
});

test('autoforge: TTS gets the cleaned narration, render gets the configured aspect, real errors surface', async () => {
  const dir = tmpDir();
  let ttsArgs = null; let renderArgs = null; let queriesSeen = null;
  const { deps } = baseDeps(dir, {
    sendChat: async () => ({ text: '# শিরোনাম\n\n**HOOK:** আজ আমরা কফি নিয়ে কথা বলব। [ON SCREEN: কফি]\n' }),
    findStockFootage: async (o) => { queriesSeen = o.queries; return { stub: false, provider: 'pexels', count: 1, shots: [{ file: 'a.mp4', start: 0, end: 5, stub: false }] }; },
  });
  const orig = deps.executeTool;
  deps.executeTool = async (name, argsRaw, ctx) => {
    if (name === 'tts_synth') { ttsArgs = JSON.parse(argsRaw); return { content: JSON.stringify({ audio: 'v.mp3', duration: 9, stub: false }) }; }
    if (name === 'render_video') { renderArgs = JSON.parse(argsRaw); return { error: true, content: 'error: no playable shot files were provided' }; }
    return orig(name, argsRaw, ctx);
  };
  const { events, emit } = collect();
  await runAutoForge({ idea: 'কফি বানানো', cfg: { model: 'm', videoAspect: '9:16', videoResolution: 720 }, emit, onQuestion: async () => UPLOAD_NO, deps });

  assert.ok(!/ON SCREEN|HOOK|\*\*|#/.test(ttsArgs.text), ttsArgs.text);
  assert.match(ttsArgs.text, /আজ আমরা কফি নিয়ে কথা বলব।/);
  assert.ok(Array.isArray(queriesSeen) && queriesSeen.length >= 1);
  assert.equal(renderArgs.aspect, '9:16');
  assert.equal(renderArgs.resolution, 720);
  const render = events.filter((e) => e.event === 'autoforge' && e.data.id === 'render' && e.data.status === 'skipped')[0];
  assert.match(render.data.detail, /no playable shot files/);       // the real reason, not "worker offline"
});
