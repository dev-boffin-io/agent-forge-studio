'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const music = require('../lib/music');

function write(rel, text = 'audio') {
  const abs = path.join(ctx.dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

test('music: lists audio files recursively and ignores other files', () => {
  write('music-list/calm-ambient.mp3');
  write('music-list/brand/cinematic-drive.m4a');
  write('music-list/notes.txt');
  write('music-list/.hidden.mp3');
  const cfg = { music: { dir: 'music-list' } };
  const r = music.listMusic({ workDir: ctx.dir, cfg });
  const files = r.files.map((f) => f.file).sort();
  assert.deepEqual(files, [path.join('music-list', 'brand', 'cinematic-drive.m4a'), path.join('music-list', 'calm-ambient.mp3')].sort());
  assert.deepEqual(r.dirs, ['music-list']);
});

test('music: respects a custom folder and assets/music fallback', () => {
  write('assets/music/soft-piano.wav');
  write('custom/track.ogg');
  const custom = music.listMusic({ workDir: ctx.dir, cfg: { music: { dir: 'custom' } } });
  assert.deepEqual(custom.files.map((f) => f.file), [path.join('custom', 'track.ogg')]);

  const fallback = music.listMusic({ workDir: ctx.dir, cfg: {} });
  assert.ok(fallback.dirs.includes(path.join('assets', 'music')));
  assert.ok(fallback.files.some((f) => f.file === path.join('assets', 'music', 'soft-piano.wav')));
});

test('music: pickMusic is deterministic and prefers mood words', () => {
  write('pick/calm-ambient.mp3');
  write('pick/energetic-drive.mp3');
  const files = music.listMusic({ workDir: ctx.dir, cfg: { music: { dir: 'pick' } } }).files;
  const a = music.pickMusic(files, { mood: 'energetic', seed: 'video-1' });
  const b = music.pickMusic(files, { mood: 'energetic', seed: 'video-1' });
  assert.equal(a.file, b.file);
  assert.equal(a.name, 'energetic-drive.mp3');
  assert.equal(music.pickMusic([], { mood: 'x', seed: 'y' }), null);
});

test('music: resolveMusic honours an explicit workspace file and applies defaults', () => {
  const abs = write('explicit/theme.mp3');
  const r = music.resolveMusic({ workDir: ctx.dir, cfg: { music: { dir: 'nope' } }, file: 'explicit/theme.mp3' });
  assert.equal(r.file, path.join('explicit', 'theme.mp3'));
  assert.equal(r.absolute, abs);
  assert.equal(r.volume, 0.12);
  assert.equal(r.duck, true);
  assert.equal(r.fadeSeconds, 2);
  assert.equal(r.source, 'explicit');
});

test('music: resolveMusic auto-picks and respects configured volume/duck/fade', () => {
  write('auto/one.mp3');
  const r = music.resolveMusic({
    workDir: ctx.dir, seed: 'stable',
    cfg: { music: { dir: 'auto', volume: 0.05, duck: false, fadeSeconds: 0.5, enabled: true } },
  });
  assert.equal(r.file, path.join('auto', 'one.mp3'));
  assert.equal(r.volume, 0.05);
  assert.equal(r.duck, false);
  assert.equal(r.fadeSeconds, 0.5);
  assert.equal(r.source, 'folder');
  assert.equal(music.resolveMusic({ workDir: ctx.dir, cfg: { music: { dir: 'missing' } }, file: 'nope.mp3' }), null);
});
