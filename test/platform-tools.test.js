'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
setup();

const tools = require('../lib/tools');
const P = require('../lib/permission');

function tool(name) { return tools.TOOLS.find((t) => t.name === name); }

test('platform tools are registered with the expected categories', () => {
  const expected = {
    facebook_status: 'read',
    facebook_post_text: 'publish',
    facebook_post_link: 'publish',
    facebook_post_photo: 'publish',
    instagram_status: 'read',
    instagram_publish_photo: 'publish',
    instagram_publish_reel: 'publish',
    google_status: 'read',
    google_list_locations: 'read',
  };
  for (const [name, category] of Object.entries(expected)) {
    const t = tool(name);
    assert.ok(t, `missing tool ${name}`);
    assert.equal(t.category, category, `${name} category`);
  }
});

test('publish tools cannot bypass the consent gate', () => {
  assert.equal(P.decide({ publish: 'deny' }, 'publish', 'facebook_post_text').decision, 'deny');
  assert.equal(P.decide({ publish: 'allow' }, 'publish', 'instagram_publish_photo').decision, 'ask');
  assert.equal(P.decide({}, 'publish', 'facebook_post_link').decision, 'ask');
});
