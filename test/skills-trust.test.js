'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-trust-home-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-trust-work-'));
process.env.YOUTUBE_STUDIO_HOME = home;
const cfg = require('../lib/config');
cfg.setWorkDir(work);

test.after(() => {
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('installed skills with trusted:false are detected by path and by the skill loader', () => {
  const dir = path.join(cfg.studioDir(), 'skills', 'untrusted');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Untrusted\n---\nRun the bundled script.\n');
  fs.writeFileSync(path.join(dir, '.source.json'), JSON.stringify({ trusted: false, repo: 'acme/demo', commit: 'abc' }));

  const skills = require('../lib/skills');
  skills.clearCache();
  const loaded = skills.loadSkill('untrusted');
  assert.equal(loaded.trusted, false);
  assert.equal(skills.untrustedSkillForPath('.ytstudio/skills/untrusted/SKILL.md'), 'untrusted');
  assert.equal(skills.untrustedSkillForPath(path.join(dir, 'SKILL.md')), 'untrusted');
  assert.equal(skills.untrustedSkillForPath('some/other/file.txt'), null);
});

test('commandUsesSkillScript recognises bundled scripts', () => {
  const skills = require('../lib/skills');
  assert.equal(skills.commandUsesSkillScript('bash .ytstudio/skills/untrusted/run.sh'), true);
  assert.equal(skills.commandUsesSkillScript('python3 .ytstudio/skills/untrusted/run.py'), true);
  assert.equal(skills.commandUsesSkillScript('ls -la .ytstudio/skills/untrusted'), false);
  assert.equal(skills.commandUsesSkillScript('echo hello'), false);
});

test('forceAsk turns an allowed action into a prompt, while deny still wins', async () => {
  const { makeGate } = require('../lib/permission');
  let asked = 0;
  const gate = makeGate({ bash: 'allow', browser_write: 'allow' }, async (req) => {
    asked += 1;
    assert.match(String(req.reason || ''), /untrusted|bundled/);
    return true;
  });

  const bash = await gate('bash', 'bash .ytstudio/skills/untrusted/run.sh', 'bash', { forceAsk: true, reason: 'an untrusted skill is loaded' });
  assert.equal(bash.ok, true);
  const browser = await gate('browser_write', 'browser_click', 'browser_click', { forceAsk: true, reason: 'an untrusted skill is loaded' });
  assert.equal(browser.ok, true);
  assert.equal(asked, 2);

  const denied = makeGate({ bash: 'deny' }, async () => true);
  const res = await denied('bash', 'rm -rf /', 'bash', { forceAsk: true, reason: 'an untrusted skill is loaded' });
  assert.equal(res.ok, false);
});
