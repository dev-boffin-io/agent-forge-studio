'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.YOUTUBE_STUDIO_HOME = process.env.YOUTUBE_STUDIO_HOME || '/tmp/ytstudio-browser-test';

const browser = require('../lib/browser');
const tools = require('../lib/tools');
const { decide } = require('../lib/permission');
const { getAgent } = require('../lib/agents');
const { studioDir } = require('../lib/config');

test('browser tools are registered under the browser category', () => {
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_wait', 'browser_upload', 'browser_select', 'browser_press', 'browser_scroll',
    'browser_screenshot', 'browser_save_state', 'browser_close']) {
    const t = tools.byName.get(name);
    assert.ok(t, `${name} should be registered`);
    assert.equal(t.category, 'browser', `${name} category`);
    assert.equal(typeof t.exec, 'function');
  }
});

test('session file lives in the per-channel studio dir', () => {
  const expected = path.join(studioDir(), 'browser', 'youtube.auth.json');
  assert.equal(browser.AUTH_FILE(), expected);
  const info = browser.authInfo();
  assert.equal(info.file, expected);
  assert.equal(typeof info.exists, 'boolean');
});

test('browser permission defaults to allow, but honors deny', () => {
  assert.equal(decide({}, 'browser').decision, 'allow');
  assert.equal(decide({ browser: 'deny' }, 'browser').decision, 'deny');
  assert.equal(decide({ browser: 'ask' }, 'browser').decision, 'ask');
});

test('read-only subagents cannot drive the browser', () => {
  for (const id of ['analyze', 'scout', 'reviewer']) {
    const a = getAgent(id);
    assert.ok(a, `${id} exists`);
    assert.equal((a.permission || {}).browser, 'deny', `${id} browser`);
  }
  assert.equal((getAgent('create').permission || {}).browser, undefined);
});

test('locate maps selector engines', () => {
  const fakePage = { locator: (s) => ({ selector: s, first() { return this; }, waitFor: async () => {} }) };
  browser.locate(fakePage, 'text=Create');
  browser.locate(fakePage, '//button');
  browser.locate(fakePage, '#upload');
  assert.throws(() => browser.locate(fakePage, '   '), /empty selector/);
});

test('auth dir is created on save path (no launch required)', () => {
  assert.equal(path.basename(path.dirname(browser.AUTH_FILE())), 'browser');
  assert.ok(browser.AUTH_FILE().endsWith(path.join('browser', 'youtube.auth.json')));
});

test('playwright is resolvable (installed as a dependency)', () => {
  assert.equal(browser.havePlaywright(), true);
});
