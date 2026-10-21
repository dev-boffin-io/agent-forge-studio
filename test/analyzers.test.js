'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
process.env.YOUTUBE_STUDIO_HOME = '/tmp/ytstudio-test-an';
require('fs').mkdirSync('/tmp/ytws-an', { recursive: true });
require('../lib/config').setWorkDir('/tmp/ytws-an');

const { load } = require('../lib/youtube/transcript');
const srt = `1
00:00:00,000 --> 00:00:02,000
This is the first sentence.

2
00:00:02,000 --> 00:00:05,000
Now we talk about something else.
`;
const f = '/tmp/test.srt';
fs.writeFileSync(f, srt);
const cues = load(f);
assert.ok(cues.length === 2);
