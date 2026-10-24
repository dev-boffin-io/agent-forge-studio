'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const ws = require('../lib/workspace');
const cfg = ctx.cfg;

test('safeResolve: keeps relative paths inside the working directory', () => {
  assert.throws(() => ws.safeResolve('src/deep/../app.js'), /escapes the workspace/);
  assert.equal(ws.safeResolve('./README.md'), path.join(cfg.getWorkDir(), 'README.md'));
});

test('safeResolve: rejects traversal, absolute paths, and home paths', () => {
  assert.throws(() => ws.safeResolve('../outside.txt'), /escapes the workspace/);
  assert.throws(() => ws.safeResolve('a/../../outside.txt'), /escapes the workspace/);
  assert.throws(() => ws.safeResolve('/etc/passwd'), /escapes the workspace/);
  assert.throws(() => ws.safeResolve('~/secret'), /escapes the workspace/);
});

test('safeResolve: .ytstudio/... maps to the studio data dir, not the project', () => {
  const p = ws.safeResolve('.ytstudio/uploads/x.png');
  assert.ok(p.startsWith(fs.realpathSync(ctx.studioDir)), `${p} should live under ${ctx.studioDir}`);
  assert.ok(p.endsWith(path.join('uploads', 'x.png')));
});

test('write/read/delete round-trip', () => {
  ws.writeFile('nested/deep/a.txt', 'hello');
  const got = ws.readFile('nested/deep/a.txt');
  assert.equal(got.path, 'nested/deep/a.txt');
  assert.equal(got.content, 'hello');
  assert.equal(got.size, 5);
  assert.throws(() => ws.readFile('nested'), /not a file/);
  ws.deleteFile('nested/deep/a.txt');
  assert.throws(() => ws.readFile('nested/deep/a.txt'), /not a file|ENOENT/);
  assert.throws(() => ws.deleteFile('.'), /is a directory|refuses directories/);
});

test('editFile replaces exactly and refuses ambiguous matches', () => {
  ws.writeFile('edit.txt', 'one two one');
  assert.throws(() => ws.editFile('edit.txt', 'one', 'three'), /occurs 2 times/);
  const r = ws.editFile('edit.txt', 'one', 'three', { replaceAll: true });
  assert.equal(r.replacements, 2);
  assert.equal(ws.readFile('edit.txt').content, 'three two three');
});

test('listDir skips ignored folders and sorts directories first', () => {
  fs.mkdirSync(path.join(ctx.dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.mkdirSync(path.join(ctx.dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, '.git', 'config'), 'x');
  fs.mkdirSync(path.join(ctx.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'src', 'a.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(ctx.dir, 'README.md'), '# hi\n');

  const flat = ws.listDir(cfg.getWorkDir(), { recursive: true }).map((e) => e.path);
  assert.ok(flat.includes('src/'));
  assert.ok(flat.includes('src/a.js'));
  assert.ok(flat.includes('README.md'));
  assert.ok(!flat.some((p) => p.includes('node_modules') || p.includes('.git')));
  const top = ws.listDir(cfg.getWorkDir());
  assert.equal(top[0].type, 'dir');
});

test('glob: ** semantics, path-anchored patterns, braces', () => {
  fs.mkdirSync(path.join(ctx.dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'src', 'deep', 'c.js'), 'x');
  fs.writeFileSync(path.join(ctx.dir, 'src', 'b.ts'), 'export {};\n');
  assert.deepEqual(ws.glob('*.md'), ['README.md']);
  assert.deepEqual(ws.glob('**/*.js').sort(), ['src/a.js', 'src/deep/c.js']);
  assert.deepEqual(ws.glob('src/*.js'), ['src/a.js']);
  assert.deepEqual(ws.glob('src/**/*.{js,ts}').sort(), ['src/a.js', 'src/b.ts', 'src/deep/c.js']);
});

test('grep: structured matches, include filter, invalid regex', () => {
  const hits = ws.grep('console\\.log', { include: '*.js' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'src/a.js');
  assert.equal(hits[0].line, 1);
  assert.match(hits[0].text, /console\.log/);
  assert.deepEqual(ws.grep('console\\.log', { include: '*.ts' }), []);
  assert.throws(() => ws.grep('([', {}), /invalid regex/);

  fs.writeFileSync(path.join(ctx.dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  const all = ws.grep('\\x00', {});
  assert.ok(!all.some((h) => h.path === 'bin.dat'));
});
