'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.YOUTUBE_STUDIO_HOME = '/tmp/ytstudio-test-topic';
require('fs').mkdirSync('/tmp/ytws-topic', { recursive: true });
require('../lib/config').setWorkDir('/tmp/ytws-topic');
