'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'web-home-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'web-work-'));
process.env.YOUTUBE_STUDIO_HOME = home;
const cfg = require('../lib/config');
cfg.setWorkDir(work);
const web = require('../lib/web');

const realFetch = global.fetch;

test.after(() => {
  global.fetch = realFetch;
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('safeFilename strips paths and reserved characters', () => {
  assert.equal(web.safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(web.safeFilename('a<b>:"c|d?.txt'), 'a-b-c-d-.txt');
  assert.equal(web.safeFilename('...'), 'download');
  assert.equal(web.safeFilename(''), 'download');
  assert.equal(web.safeFilename('x'.repeat(500)).length, 180);
});

test('filenameFromDisposition understands plain and RFC 5987 names', () => {
  assert.equal(web.filenameFromDisposition('attachment; filename="report final.pdf"'), 'report final.pdf');
  assert.equal(web.filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.mp4"), 'café.mp4');
  assert.equal(web.filenameFromDisposition(''), '');
});

test('filenameFromUrl uses the URL basename and content-type fallback', () => {
  assert.equal(web.filenameFromUrl('https://example.com/media/clip.mp4?x=1'), 'clip.mp4');
  assert.equal(web.filenameFromUrl('https://example.com/', 'application/pdf'), 'download.pdf');
  assert.equal(web.filenameFromUrl('not a url', 'image/png'), 'download.png');
});

test('private and non-http URLs are rejected before fetching', async () => {
  global.fetch = async () => { throw new Error('fetch should not be called'); };
  await assert.rejects(() => web.downloadUrl('http://127.0.0.1/secret'), /private\/local/);
  await assert.rejects(() => web.downloadUrl('file:///etc/passwd'), /only http/);
  await assert.rejects(() => web.downloadUrl('nope'), /not a valid URL/);
});

test('downloadUrl writes into the workspace, honours the header name and avoids overwriting', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(Buffer.from('hello download'), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"', 'content-length': '14' },
    });
  };
  const first = await web.downloadUrl('https://example.com/get?id=1', { destDir: 'media' });
  assert.equal(first.ok, true);
  assert.equal(first.path, 'media/report.pdf');
  assert.equal(fs.readFileSync(path.join(work, first.path), 'utf8'), 'hello download');
  const second = await web.downloadUrl('https://example.com/get?id=2', { destDir: 'media' });
  assert.equal(second.path, 'media/report-2.pdf');
  assert.equal(calls, 2);
});

test('downloadUrl rejects a body larger than maxBytes', async () => {
  global.fetch = async () => new Response(Buffer.alloc(20), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  await assert.rejects(() => web.downloadUrl('https://example.com/big', { maxBytes: 5 }), /too large/);
});

test('html helpers decode entities and produce readable text/markdown', () => {
  assert.equal(web.htmlToText('<p>Hello&nbsp;<b>world</b></p>'), 'Hello world');
  assert.match(web.htmlToMarkdown('<h2>Title</h2><p><a href="https://x.test">link</a></p>'), /## Title/);
  assert.match(web.htmlToMarkdown('<h2>Title</h2><p><a href="https://x.test">link</a></p>'), /\[link\]\(https:\/\/x\.test\)/);
});
