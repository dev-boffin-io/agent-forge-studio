'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-home-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-work-'));
process.env.YOUTUBE_STUDIO_HOME = home;
const cfg = require('../lib/config');
cfg.setWorkDir(work);
const hub = require('../lib/skillhub');
const skills = require('../lib/skills');

const realFetch = global.fetch;

test.after(() => {
  global.fetch = realFetch;
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('parseSource accepts shorthands, refs and GitHub URLs', () => {
  assert.deepEqual(hub.parseSource('owner/repo'), { owner: 'owner', repo: 'repo', ref: null, path: '' });
  assert.deepEqual(hub.parseSource('owner/repo/path/to/skill'), { owner: 'owner', repo: 'repo', ref: null, path: 'path/to/skill' });
  assert.deepEqual(hub.parseSource('owner/repo#dev'), { owner: 'owner', repo: 'repo', ref: 'dev', path: '' });
  assert.deepEqual(hub.parseSource('https://github.com/a/b/tree/main/skills/pdf'), { owner: 'a', repo: 'b', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(hub.parseSource('https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md'), { owner: 'a', repo: 'b', ref: 'main', path: 'skills/pdf/SKILL.md' });
  assert.throws(() => hub.parseSource('not-a-repo'), /expected owner\/repo/);
  assert.throws(() => hub.parseSource('https://example.com/a/b'), /only github/);
});

test('skillId sanitises folder names and never escapes the skills root', () => {
  assert.equal(hub.skillId('skills/PDF Tools'), 'PDF-Tools');
  assert.equal(hub.skillId('../../evil'), 'evil');
  assert.equal(hub.skillId('...'), 'skill');
});

function mockGitHub(files) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/acme/demo') {
      return new Response(JSON.stringify({ full_name: 'acme/demo', default_branch: 'main', html_url: 'https://github.com/acme/demo', stargazers_count: 7 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/git/trees/main?recursive=1')) {
      return new Response(JSON.stringify({ tree: Object.keys(files).map((p) => ({ path: p, type: 'blob' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://raw.githubusercontent.com/acme/demo/main/')) {
      const rel = decodeURIComponent(u.slice('https://raw.githubusercontent.com/acme/demo/main/'.length));
      if (!(rel in files)) return new Response('not found', { status: 404 });
      return new Response(files[rel], { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('unexpected ' + u, { status: 500 });
  };
}

test('listGitHubSkills reads frontmatter without installing', async () => {
  mockGitHub({
    'skills/pdf/SKILL.md': '---\nname: PDF Tools\ndescription: Work with PDFs\n---\nBody\n',
    'skills/pdf/scripts/run.py': 'print(1)\n',
  });
  const out = await hub.listGitHubSkills('acme/demo');
  assert.equal(out.repo, 'acme/demo');
  assert.equal(out.skills.length, 1);
  assert.equal(out.skills[0].id, 'pdf');
  assert.equal(out.skills[0].name, 'PDF Tools');
  assert.equal(out.skills[0].description, 'Work with PDFs');
});

test('installSkill installs every file and becomes loadable by the skills loader', async () => {
  mockGitHub({
    'skills/pdf/SKILL.md': '---\nname: PDF Tools\ndescription: Work with PDFs\n---\nUse this for PDFs.\n',
    'skills/pdf/scripts/run.py': 'print(1)\n',
  });
  const out = await hub.installSkill('acme/demo/skills/pdf');
  assert.equal(out.ok, true);
  assert.equal(out.installed.length, 1);
  assert.equal(out.installed[0].id, 'pdf');
  assert.equal(out.installed[0].files, 2);
  const dest = path.join(hub.skillsRoot(), 'pdf');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dest, 'scripts', 'run.js').replace('.js', '.py')));
  assert.ok(fs.existsSync(path.join(dest, '.source.json')));
  const loaded = skills.loadSkill('pdf');
  assert.ok(loaded);
  assert.ok(loaded.body.includes('Use this for PDFs.'));
  assert.equal(hub.installedSkills()[0].repo, 'acme/demo');
});

test('installSkill refuses to overwrite unless force is set', async () => {
  mockGitHub({ 'skills/pdf/SKILL.md': '---\nname: PDF Tools\n---\nv2\n' });
  await assert.rejects(() => hub.installSkill('acme/demo/skills/pdf'), /already installed/);
  const out = await hub.installSkill('acme/demo/skills/pdf', { force: true });
  assert.equal(out.ok, true);
  assert.ok(fs.readFileSync(path.join(hub.skillsRoot(), 'pdf', 'SKILL.md'), 'utf8').includes('v2'));
});

test('a multi-skill source asks for a selection instead of installing everything', async () => {
  mockGitHub({
    'audio/SKILL.md': '---\nname: Audio\n---\nbody\n',
    'video/SKILL.md': '---\nname: Video\n---\nbody\n',
  });
  const out = await hub.installSkill('acme/demo');
  assert.equal(out.ok, false);
  assert.equal(out.needsSelection, true);
  assert.deepEqual(out.skills.map((s) => s.id).sort(), ['audio', 'video']);
});
