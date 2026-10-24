'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const agents = require('../lib/agents');

test('built-in agents cover the studio roles', () => {
  const all = agents.allAgents();
  for (const id of ['create', 'analyze', 'scout', 'reviewer']) assert.ok(all[id], `missing ${id}`);
  assert.equal(all.create.primary, true);
  assert.equal(all.analyze.primary, true);
  assert.equal(all.scout.subagent, true);
  assert.equal(all.reviewer.subagent, true);
  assert.equal(all.analyze.voice, false);
  assert.equal(all.reviewer.voice, true);
  assert.equal(agents.getAgent('nope').id, 'create');
});

test('built-in agents have the expected permission posture', () => {
  assert.equal(agents.getAgent('create').permission, null);
  assert.equal(agents.getAgent('analyze').permission.edit, 'deny');
  assert.equal(agents.getAgent('analyze').permission.bash['*'], 'deny');
  assert.equal(agents.getAgent('analyze').permission.bash['ls *'], 'allow');
  assert.equal(agents.getAgent('scout').permission.webfetch, 'allow');
  assert.equal(agents.getAgent('reviewer').permission.edit, 'deny');
});

test('custom JSON agents load from the studio and project folders', () => {
  const dir = path.join(ctx.studioDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'editor.json'), JSON.stringify({
    id: 'editor', label: 'Editor', subagent: true, voice: true,
    system: 'Edit things carefully.', permission: { edit: 'ask' },
  }), 'utf8');
  const a = agents.getAgent('editor');
  assert.ok(a);
  assert.equal(a.label, 'Editor');
  assert.equal(a.subagent, true);
  assert.equal(a.system, 'Edit things carefully.');
  assert.deepEqual(a.permission, { edit: 'ask' });
  assert.ok(agents.allAgents().editor);

  const projectDir = path.join(ctx.cfg.getWorkDir(), 'agents');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'editor.json'), JSON.stringify({ id: 'editor', label: 'Project Editor' }), 'utf8');
  assert.equal(agents.getAgent('editor').label, 'Project Editor');
});

test('custom agents can override a built-in by id', () => {
  const dir = path.join(ctx.studioDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scout.json'), JSON.stringify({ id: 'scout', label: 'Researcher' }), 'utf8');
  assert.equal(agents.getAgent('scout').label, 'Researcher');
  assert.equal(agents.getAgent('scout').system, agents.BUILTINS.scout.system);
});

test('systemPromptFor includes the base prompt, agent prompt, and voice only when enabled', () => {
  const cfg = { systemPrompt: 'BASE PROMPT' };
  const text = agents.systemPromptFor(agents.getAgent('create'), cfg, 'VOICE RULES');
  assert.ok(text.includes('BASE PROMPT'));
  assert.ok(text.includes(agents.BUILTINS.create.system));
  assert.ok(text.includes('VOICE RULES'));
  assert.ok(text.includes('<untrusted_page_content>'));

  const noVoice = agents.systemPromptFor(agents.getAgent('analyze'), cfg, 'VOICE RULES');
  assert.ok(!noVoice.includes('VOICE RULES'));
});
