'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../lib/cli');

test('parseCli extracts global flags around the command', () => {
  assert.deepEqual(cli.parseCli(['--dir', '/tmp/channel', '--json', 'run', 'make', 'a', 'script']), {
    command: 'run',
    args: ['make', 'a', 'script'],
    opts: { dir: '/tmp/channel', agent: null, session: null, model: null, yes: false, json: true, all: false, force: false, includeText: false },
  });
  assert.equal(cli.parseCli([]).command, 'help');
});

test('parseCli supports short flags, --prompt and install-skill aliases', () => {
  assert.equal(cli.parseCli(['-y', '-m', 'gpt', '-a', 'create', 'run', 'x']).opts.model, 'gpt');
  assert.deepEqual(cli.parseCli(['--prompt', 'hello']).args, ['hello']);
  const install = cli.parseCli(['install-skill', 'owner/repo']);
  assert.equal(install.command, 'skills');
  assert.deepEqual(install.args, ['install', 'owner/repo']);
});

test('handles only claims actual CLI invocations', () => {
  assert.equal(cli.handles([]), false);
  assert.equal(cli.handles(['--no-open']), false);
  assert.equal(cli.handles(['--dir', '/tmp/x', 'skills', 'list']), true);
  assert.equal(cli.handles(['--session', 'abc', 'run', 'x']), true);
  assert.equal(cli.handles(['--prompt', 'x']), true);
  assert.equal(cli.handles(['--port', '8080']), false);
});
