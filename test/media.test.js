'use strict';

// Media integrations — the PNG thumbnail encoder, Pexels footage download and the TTS/render
// worker tool calls. Network is mocked by replacing global.fetch so no key/worker is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setup } = require('./helpers');
const { dir } = setup(); // sets the workspace before lib/* load

const { encodePng, Canvas } = require('../lib/png');
const stubs = require('../lib/autoforge-stubs');
const tools = require('../lib/tools');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'media-')); }

// ---- PNG encoder ----------------------------------------------------------------------------

test('png: encodePng produces a valid PNG signature + IHDR for the requested size', () => {
  const c = new Canvas(32, 16);
  c.fillGradient([0, 0, 0], [255, 255, 255]);
  const png = c.toPng();
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'PNG signature');
  // IHDR starts at byte 8 (len) + 4 (type) = 12
  assert.equal(png.readUInt32BE(16), 32, 'width');
  assert.equal(png.readUInt32BE(20), 16, 'height');
  assert.ok(png.includes(Buffer.from('IEND')), 'has IEND');
});

test('png: encodePng rejects nothing for a 1x1 canvas and is deterministic', () => {
  const a = encodePng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0]) });
  const b = encodePng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0]) });
  assert.ok(a.equals(b), 'same input → identical bytes');
});

// ---- thumbnail ------------------------------------------------------------------------------

test('thumbnail: generateThumbnail writes a real 1280x720 PNG (stub:false)', async () => {
  const dirT = tmpDir();
  const out = path.join(dirT, 'thumb.png');
  const r = await stubs.generateThumbnail({ title: 'Why Channels Stall', outPath: out });
  assert.equal(r.stub, false);
  assert.equal(r.format, 'png');
  const buf = fs.readFileSync(out);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), 'wrote a PNG');
  assert.equal(buf.readUInt32BE(16), 1280);
  assert.equal(buf.readUInt32BE(20), 720);
});

test('thumbnail: long titles still produce a valid PNG', async () => {
  const dirT = tmpDir();
  const out = path.join(dirT, 'long.png');
  const r = await stubs.generateThumbnail({ title: 'A VERY LONG TITLE THAT KEEPS GOING AND GOING FOREVER', outPath: out });
  assert.equal(r.stub, false);
  assert.ok(fs.readFileSync(out).subarray(0, 8).equals(PNG_SIG));
});

// ---- Pexels footage -------------------------------------------------------------------------

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    json: async () => obj,
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)).buffer,
    text: async () => JSON.stringify(obj),
  };
}

test('pexels: no key → graceful stub with file:null shots', async () => {
  const r = await stubs.findStockFootage({ topic: 'coffee', workDir: tmpDir(), cfg: {} });
  assert.equal(r.stub, true);
  assert.ok(r.shots.every((s) => s.file === null));
  assert.ok(r.todo.includes('PEXELS_API_KEY'));
});

test('pexels: downloads clips and returns real shots (stub:false)', async () => {
  const dirT = tmpDir();
  const videoBody = Buffer.from('FAKE-MP4-BYTES');
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes('api.pexels.com')) {
      return jsonResponse({
        videos: [
          { id: 1, duration: 8, video_files: [{ file_type: 'video/mp4', width: 1920, link: 'https://videos.pexels.com/clip1.mp4' }] },
          { id: 2, duration: 6, video_files: [{ file_type: 'video/mp4', width: 1280, link: 'https://videos.pexels.com/clip2.mp4' }] },
        ],
      });
    }
    return { ok: true, status: 200, arrayBuffer: async () => videoBody.buffer.slice(videoBody.byteOffset, videoBody.byteOffset + videoBody.byteLength), text: async () => '' };
  }, async () => {
    const r = await stubs.findStockFootage({ topic: 'coffee brewing', workDir: dirT, cfg: { pexelsApiKey: 'k' }, count: 4 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'pexels');
    assert.equal(r.shots.length, 2);
    for (const s of r.shots) {
      assert.equal(s.stub, false);
      assert.ok(s.file && s.file.endsWith('.mp4'));
      const abs = path.join(dirT, s.file);
      assert.ok(fs.existsSync(abs), `downloaded ${abs}`);
      assert.equal(fs.readFileSync(abs).toString(), 'FAKE-MP4-BYTES');
      assert.ok(typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start);
    }
    // the auth header was sent
    assert.ok(calls.some((u) => u.includes('api.pexels.com')));
  });
});

test('pexels: a search failure degrades to a stub (never throws)', async () => {
  const dirT = tmpDir();
  await withMockFetch(async () => ({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }), async () => {
    const r = await stubs.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pexelsApiKey: 'k' } });
    assert.equal(r.stub, true);
    assert.ok(r.shots.length >= 1);
  });
});

// ---- worker tools ---------------------------------------------------------------------------

test('tools: tts_synth POSTs to the TTS worker and returns the real audio', async () => {
  await withMockFetch(async (url, opts) => {
    assert.ok(String(url).endsWith('/synth'), `route: ${url}`);
    const body = JSON.parse(opts.body);
    assert.equal(body.text, 'hello world');
    return jsonResponse({ audio: '/abs/voice.mp3', duration: 3.2, stub: false });
  }, async () => {
    const res = await tools.executeTool('tts_synth', JSON.stringify({ text: 'hello world' }), { cfg: { ttsWorkerUrl: 'http://127.0.0.1:8101' } });
    assert.equal(res.error, false);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.audio, '/abs/voice.mp3');
    assert.equal(parsed.stub, false);
  });
});

test('tools: tts_synth surfaces a worker error instead of a stub', async () => {
  await withMockFetch(async () => ({ ok: false, status: 503, text: async () => 'edge-tts not installed', json: async () => ({}) }), async () => {
    const res = await tools.executeTool('tts_synth', JSON.stringify({ text: 'x' }), { cfg: {} });
    assert.equal(res.error, true);
    assert.match(res.content, /error:/);
  });
});

test('tools: render_video resolves shot paths and posts them to the render worker', async () => {
  const f = path.join(dir, 'shot.mp4');
  fs.writeFileSync(f, 'x');
  await withMockFetch(async (url, opts) => {
    assert.ok(String(url).endsWith('/render'), `route: ${url}`);
    const body = JSON.parse(opts.body);
    assert.equal(body.shots.length, 1);
    assert.equal(body.shots[0].file, f, 'workspace-relative path resolved to absolute');
    return jsonResponse({ video: '/abs/out.mp4', duration: 10, stub: false });
  }, async () => {
    const res = await tools.executeTool('render_video', JSON.stringify({ shots: [{ file: 'shot.mp4', start: 0, end: 5 }], audio: null }), { cfg: {} });
    assert.equal(res.error, false);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.video, '/abs/out.mp4');
    assert.equal(parsed.stub, false);
  });
});

test('tools: workerUrl reads config with sensible localhost defaults', () => {
  assert.equal(tools.workerUrl({}, 'tts'), 'http://127.0.0.1:8101');
  assert.equal(tools.workerUrl({}, 'render'), 'http://127.0.0.1:8102');
  assert.equal(tools.workerUrl({ ttsWorkerUrl: 'http://host:9000/' }, 'tts'), 'http://host:9000');
  assert.equal(tools.workerUrl({ workers: { render: 'http://w:1' } }, 'render'), 'http://w:1');
});
