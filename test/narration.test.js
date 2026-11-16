'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toNarration } = require('../lib/narration');

test('narration: strips cues, markdown, labels and timestamps', () => {
  const script = [
    '# Why Coffee Wins',
    '',
    '**HOOK (0:00–0:10):** Did you know coffee is a fruit? [ON SCREEN: coffee cherries]',
    '- First, the beans. [B-ROLL: roasting]',
    '---',
    '(pause for effect)',
    'VOICEOVER: Thanks for [watching](https://x.y)!',
  ].join('\n');
  const out = toNarration(script);
  assert.ok(!/ON SCREEN|B-ROLL|\*\*|#|\(0:00|https|VOICEOVER|HOOK/.test(out), out);
  assert.match(out, /Did you know coffee is a fruit\?/);
  assert.match(out, /First, the beans\./);
  assert.match(out, /Thanks for watching!/);
  assert.ok(!/pause for effect/.test(out));
});

test('narration: keeps Bengali / mixed-language text intact', () => {
  const out = toNarration('## শুরু\n\nআজ আমরা কফি নিয়ে কথা বলব। Welcome back! [ON SCREEN: কফি]');
  assert.match(out, /আজ আমরা কফি নিয়ে কথা বলব।/);
  assert.match(out, /Welcome back!/);
  assert.ok(!/ON SCREEN/.test(out));
});

test('narration: long scripts are cut at a sentence boundary, not mid-word', () => {
  const long = Array.from({ length: 2000 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');
  const out = toNarration(long, { max: 1000 });
  assert.ok(out.length <= 1000);
  assert.ok(out.endsWith('.'));
});

test('narration: empty / junk input gives an empty string', () => {
  assert.equal(toNarration(''), '');
  assert.equal(toNarration(null), '');
  assert.equal(toNarration('[ON SCREEN: x]\n---'), '');
});
