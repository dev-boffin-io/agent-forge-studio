'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.YOUTUBE_STUDIO_HOME = '/tmp/ytstudio-test-hooks';
require('fs').mkdirSync('/tmp/ytws-hooks', { recursive: true });
require('../lib/config').setWorkDir('/tmp/ytws-hooks');
const { scoreHook, scoreHooks } = require('../lib/youtube/hookscore');
test('hookscore gives a verdict', () => {
  const r = scoreHook('Why do your videos die at 30 seconds when the topic is fine?');
  assert.ok(typeof r.verdict === 'number');
  assert.ok(r.verdict >= 0 && r.verdict <= 100);
});
test('titlelint checks', () => {
  const r = require('../lib/youtube/titlelint').checkTitle('AI just broke the internet');
  assert.ok(typeof r.score === 'number');
});
