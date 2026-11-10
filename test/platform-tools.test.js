'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
setup();

const tools = require('../lib/tools');
const P = require('../lib/permission');

function tool(name) { return tools.PLATFORM_TOOLS[name]; }

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
    gmail_list: 'read',
    gmail_read: 'read',
    gmail_labels: 'read',
    gmail_send: 'publish',
    gmail_modify: 'publish',
    gmail_trash: 'publish',
    drive_list: 'read',
    drive_get: 'read',
    drive_download: 'edit',
    drive_upload: 'publish',
    drive_create_folder: 'publish',
    drive_delete: 'publish',
    docs_get: 'read',
    docs_create: 'publish',
    docs_append: 'publish',
    docs_replace: 'publish',
    calendar_list: 'read',
    calendar_events: 'read',
    calendar_create_event: 'publish',
    calendar_update_event: 'publish',
    calendar_delete_event: 'publish',
    photos_upload: 'publish',
    photos_list: 'read',
    photos_get: 'read',
    photos_download: 'edit',
    photos_list_albums: 'read',
    photos_create_album: 'publish',
    photos_add_to_album: 'publish',
    photos_remove_from_album: 'publish',
    photos_update_description: 'publish',
    photos_picker_create: 'read',
    photos_picker_status: 'read',
    photos_picker_wait: 'read',
    photos_picker_list: 'read',
    photos_picker_download: 'edit',
    photos_picker_delete: 'read',
    github_status: 'read',
    github_list_repos: 'read',
    github_get_repo: 'read',
    github_list_issues: 'read',
    github_get_issue: 'read',
    github_create_issue: 'publish',
    github_update_issue: 'publish',
    github_comment_issue: 'publish',
    github_list_prs: 'read',
    github_get_pr: 'read',
    github_create_pr: 'publish',
    github_list_commits: 'read',
    github_list_branches: 'read',
    github_list_releases: 'read',
    github_create_release: 'publish',
    github_get_file: 'read',
    github_write_file: 'publish',
    github_delete_file: 'publish',
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
