'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const skills = require('../lib/skills');

test('listSkills discovers workspace and studio skills', () => {
  const local = path.join(ctx.dir, 'skills', 'commit-style');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'SKILL.md'), '---\nname: commit-style\ndescription: Write good commit messages\n---\nUse the imperative mood.\n', 'utf8');

  const studio = path.join(ctx.studioDir, 'skills', 'deploy');
  fs.mkdirSync(studio, { recursive: true });
  fs.writeFileSync(path.join(studio, 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nDeploy steps.\n', 'utf8');
  skills.clearCache();

  const all = skills.listSkills();
  const commit = all.find((s) => s.id === 'commit-style');
  assert.ok(commit);
  assert.equal(commit.description, 'Write good commit messages');
  assert.equal(commit.trusted, true);
  assert.ok(all.some((s) => s.id === 'deploy'));
});

test('loadSkill returns the body and metadata', () => {
  const s = skills.loadSkill('commit-style');
  assert.ok(s);
  assert.equal(s.id, 'commit-style');
  assert.equal(s.name, 'commit-style');
  assert.ok(s.body.includes('Use the imperative mood.'));
  assert.ok(s.source.endsWith(path.join('commit-style', 'SKILL.md')));
  assert.equal(skills.loadSkill('no-such-skill'), null);
});

test('installed skills marked untrusted stay untrusted', () => {
  const dir = path.join(ctx.studioDir, 'skills', 'external');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: external\ndescription: Third party\n---\nbody\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.source.json'), JSON.stringify({ trusted: false }), 'utf8');
  skills.clearCache();
  assert.equal(skills.loadSkill('external').trusted, false);
  assert.equal(skills.listSkills().find((s) => s.id === 'external').trusted, false);
});

test('parseFrontmatter handles inline and block scalar values', () => {
  const { meta, body } = skills.parseFrontmatter('---\nname: demo\ndescription: >\n  A folded\n  description\ntrusted: false\n---\nBody text\n');
  assert.equal(meta.name, 'demo');
  assert.equal(meta.description, 'A folded description');
  assert.equal(meta.trusted, 'false');
  assert.equal(body, 'Body text');
});

test('skillDirs includes configured extra paths', () => {
  const extra = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'skill-extra-'));
  fs.mkdirSync(path.join(extra, 'special'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'special', 'SKILL.md'), '---\nname: special\n---\nbody\n', 'utf8');
  const cfgFile = path.join(ctx.studioDir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ skills: { paths: [extra] } }), 'utf8');
  try {
    const dirs = skills.skillDirs();
    assert.ok(dirs.some((d) => path.resolve(d) === path.resolve(extra)));
  } finally {
    fs.rmSync(cfgFile, { force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});
