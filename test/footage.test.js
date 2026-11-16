'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const footage = require('../lib/footage');

function write(rel, text = 'not really a video') {
  const abs = path.join(ctx.dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

test('footage: splitSentences handles multilingual punctuation and drops cues', () => {
  const parts = footage.splitSentences('[ON SCREEN] Hello there! কফি ভালো। 次の話？ - **end**');
  assert.deepEqual(parts, ['Hello there!', 'কফি ভালো।', '次の話？', 'end']);
});

test('footage: sceneWeights gives more time to longer script scenes', () => {
  const weights = footage.sceneWeights('Short. This is a much longer scene with many more words in it. Tiny.', 3);
  assert.equal(weights.length, 3);
  assert.ok(weights.every((w) => w > 0));
  assert.ok(weights[1] > weights[0]);
  assert.ok(weights[1] > weights[2]);
  assert.deepEqual(footage.sceneWeights('', 2), [1, 1]);
});

test('footage: alignShots uses explicit weights for a contiguous timeline', () => {
  const out = footage.alignShots([{ file: 'a.mp4', weight: 2 }, { file: 'b.mp4', weight: 6 }], 8);
  assert.deepEqual(out.map((s) => [s.start, s.end, s.sceneSeconds]), [[0, 2, 2], [2, 8, 6]]);
});

test('footage: alignShots distributes the whole voiceover over shots', () => {
  const out = footage.alignShots([{ file: 'a.mp4' }, { file: 'b.mp4' }], 10, 'One two three. Four five six seven eight.');
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 10);
  assert.equal(out[0].end, out[1].start);
  assert.ok(out.every((s) => s.end > s.start));
  assert.deepEqual(footage.alignShots([{ file: 'a' }], 0), [{ file: 'a' }]);
});

test('footage: orientationOf classifies frames', () => {
  assert.equal(footage.orientationOf(1920, 1080), 'landscape');
  assert.equal(footage.orientationOf(1080, 1920), 'portrait');
  assert.equal(footage.orientationOf(1000, 1000), 'square');
  assert.equal(footage.orientationOf(0, 0), '');
});

test('footage: verifyClip reports an unreadable local file instead of throwing', () => {
  write('footage/broken.mp4');
  const checked = footage.verifyClip({ file: path.join('footage', 'broken.mp4') }, { workDir: ctx.dir, cfg: {} });
  assert.equal(checked.verified, false);
  assert.ok(checked.verifyError);
});

test('footage: prepareFootage keeps stubs and reports missing local files', () => {
  const stub = footage.prepareFootage({ shots: [{ file: null, stub: true }], workDir: ctx.dir, cfg: {} });
  assert.deepEqual(stub.shots, [{ file: null, stub: true }]);
  assert.deepEqual(stub.report, []);
  assert.equal(stub.verified, true);

  write('footage/missing.mp4');
  const bad = footage.prepareFootage({ shots: [{ file: path.join('footage', 'missing.mp4') }], workDir: ctx.dir, cfg: {}, stripAudio: false });
  assert.equal(bad.verified, false);
  assert.equal(bad.report.length, 1);
  assert.equal(bad.report[0].verified, false);
  assert.ok(bad.report[0].error);
  assert.ok(bad.shots[0].verifyError);
});

test('footage: hasTool is false for an absent binary', () => {
  assert.equal(footage.hasTool('definitely-not-a-real-binary-xyz'), false);
});
