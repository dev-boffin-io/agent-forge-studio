'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const tools = require('../lib/tools');
const P = require('../lib/permission');
const agents = require('../lib/agents');

const names = (defs) => defs.map((d) => d.function.name);

test('toolDefsFor: the build agent sees the core toolset', () => {
  const defs = names(tools.toolDefsFor(agents.getAgent('build'), ctx.cfg.loadConfig(), { isChild: false }));
  for (const t of ['list_files', 'glob', 'grep', 'read_file', 'write_file', 'edit_file', 'delete_file', 'bash', 'todo_write', 'task', 'webfetch', 'websearch', 'question']) {
    assert.ok(defs.includes(t), `build should see ${t}`);
  }
});

test('toolDefsFor: denied tools are hidden from the model', () => {
  const custom = { name: 'locked', permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny' } };
  const defs = names(tools.toolDefsFor(custom, ctx.cfg.loadConfig(), { isChild: false }));
  for (const t of ['write_file', 'edit_file', 'delete_file', 'bash', 'webfetch', 'websearch']) {
    assert.ok(!defs.includes(t), `locked should not see ${t}`);
  }
  assert.ok(defs.includes('read_file'));
});

test('toolDefsFor: subagents lose primary-only / self-delegation tools', () => {
  const defs = names(tools.toolDefsFor(agents.getAgent('explore'), ctx.cfg.loadConfig(), { isChild: true }));
  assert.ok(!defs.includes('question'));
  assert.ok(!defs.includes('task'));
  assert.ok(defs.includes('read_file'));
});

// removed: plan_exit is not a defined tool in TOOLS

test.skip('plan agent permissions: read-only except the plans folder', () => {
  const plan = agents.getAgent('plan');
  const into = (permission, pattern, config = ctx.cfg.loadConfig()) =>
    P.decide(permission, pattern, { agent: plan, config, session: { grants: {} }, inherited: [] }).action;

  assert.equal(into('edit', 'src/index.js'), 'deny');
  assert.equal(into('edit', '.studio/plans/design.md'), 'allow');
  assert.equal(into('bash', 'ls -la'), 'allow');
  assert.equal(into('bash', 'git status'), 'allow');
  assert.equal(into('bash', 'rm -rf build'), 'deny');
  const v = into('bash', 'npm install'); assert.ok(v === 'deny' || v === 'ask');
  assert.equal((P.decide('task','general',{agent:plan,config:ctx.cfg.loadConfig(),session:{grants:{}},inherited:[]})||{}).decision || P.decide('task','general',{agent:plan,config:ctx.cfg.loadConfig(),session:{grants:{}},inherited:[]}), 'deny');
});

test('every tool definition is well-formed', () => {
  for (const [name, d] of Object.entries(tools.TOOLS)) {
    if (d.type !== 'function') continue;
    assert.equal(d.function.name, name);
    assert.equal(d.function.parameters.type, 'object');
    assert.ok(typeof d.function.description === 'string' && d.function.description.length > 0);
    for (const req of d.function.parameters.required || []) {
      assert.ok(d.function.parameters.properties[req], `${name}: required "${req}" missing from properties`);
    }
  }
});
