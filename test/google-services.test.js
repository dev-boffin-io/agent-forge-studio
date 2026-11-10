'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const g = require('../lib/google');
const gmail = require('../lib/google/gmail');
const drive = require('../lib/google/drive');
const docs = require('../lib/google/docs');
const calendar = require('../lib/google/calendar');

function jsonResponse(obj, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
  };
}

function bufferResponse(buf, contentType = 'application/octet-stream') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => '',
    json: async () => ({}),
    arrayBuffer: async () => buf,
  };
}

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

function validToken() {
  g.saveToken({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Date.now() + 3600_000 });
}

test.beforeEach(() => validToken());

test('gmail: list uses query + metadata and returns summaries', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/messages?') || String(url).endsWith('/messages')) {
      return jsonResponse({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 });
    }
    return jsonResponse({
      id: 'm1', threadId: 't1', snippet: 'hello there', labelIds: ['INBOX'],
      payload: { headers: [
        { name: 'Subject', value: 'Hi' },
        { name: 'From', value: 'alice@example.com' },
        { name: 'Date', value: 'Tue, 10 Nov 2026 10:00:00 +0000' },
      ] },
    });
  }, async () => {
    const r = await gmail.listMessages({ query: 'from:alice', maxResults: 5 });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].subject, 'Hi');
    assert.equal(r.messages[0].from, 'alice@example.com');
    assert.equal(r.messages[0].snippet, 'hello there');
  });
  const list = new URL(calls[0].url);
  assert.equal(list.searchParams.get('q'), 'from:alice');
  assert.equal(list.searchParams.get('maxResults'), '5');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer access-1');
});

test('gmail: read decodes the body and send builds a MIME message', async () => {
  await withMockFetch(async (url) => {
    if (String(url).includes('/send')) return jsonResponse({ id: 'sent-1', threadId: 't1' });
    return jsonResponse({
      id: 'm1', threadId: 't1', payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('plain body').toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<b>html body</b>').toString('base64url') } },
        ],
      },
    });
  }, async () => {
    const msg = await gmail.getMessage({ id: 'm1' });
    assert.equal(gmail.messageText(msg), 'plain body');

    let sentBody;
    global.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return jsonResponse({ id: 'sent-1', threadId: 't1' });
    };
    const sent = await gmail.sendMessage({ to: 'bob@example.com', subject: 'Hello', body: 'Body text' });
    assert.equal(sent.ok, true);
    const raw = Buffer.from(sentBody.raw, 'base64url').toString('utf8');
    assert.match(raw, /To: bob@example.com/);
    assert.match(raw, /Subject: Hello/);
    assert.match(raw, new RegExp(Buffer.from('Body text').toString('base64')));
  });
});

test('drive: list filters trashed files, upload sends multipart metadata + content', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/upload/')) return jsonResponse({ id: 'f1', name: 'note.txt' });
    return jsonResponse({ files: [{ id: 'f0', name: 'a.txt' }] });
  }, async () => {
    const listed = await drive.listFiles({ query: "name contains 'report'" });
    assert.equal(listed.files[0].name, 'a.txt');

    const uploaded = await drive.uploadFile({ name: 'note.txt', content: 'hello', mimeType: 'text/plain' });
    assert.equal(uploaded.id, 'f1');
  });
  const list = new URL(calls[0].url);
  assert.equal(list.searchParams.get('q'), "trashed = false and (name contains 'report')");
  assert.match(calls[1].url, /uploadType=multipart/);
  const body = Buffer.isBuffer(calls[1].opts.body) ? calls[1].opts.body : Buffer.from(calls[1].opts.body);
  assert.match(body.toString('utf8'), /"name":"note.txt"/);
  assert.match(body.toString('utf8'), /hello/);
});

test('drive: download returns a buffer and export uses mimeType', async () => {
  const calls = [];
  await withMockFetch(async (url) => {
    calls.push(String(url));
    return bufferResponse(Buffer.from('file-bytes'), 'text/plain');
  }, async () => {
    const r = await drive.downloadFile({ fileId: 'f1' });
    assert.equal(r.buffer.toString(), 'file-bytes');
    assert.equal(r.contentType, 'text/plain');
    const e = await drive.exportFile({ fileId: 'f2', mimeType: 'text/plain' });
    assert.equal(e.buffer.toString(), 'file-bytes');
  });
  assert.match(calls[0], /alt=media/);
  assert.match(calls[1], /\/export\?mimeType=text%2Fplain/);
});

test('docs: text extraction, create and append', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith(':batchUpdate')) return jsonResponse({ replies: [{}] });
    if (String(url).endsWith('/documents') && opts.method === 'POST') return jsonResponse({ documentId: 'doc-new', title: 'New' });
    return jsonResponse({
      documentId: 'doc-1', title: 'Doc',
      body: { content: [{ endIndex: 1 }, { paragraph: { elements: [{ textRun: { content: 'Hello ' } }] }, endIndex: 7 }] },
    });
  }, async () => {
    const read = await docs.getDocumentText({ documentId: 'doc-1' });
    assert.equal(read.text, 'Hello ');
    const created = await docs.createDocument({ title: 'New' });
    assert.equal(created.documentId, 'doc-new');
    const appended = await docs.appendText({ documentId: 'doc-1', text: 'world' });
    assert.equal(appended.characters, 5);
  });
  const update = calls.find((c) => c.url.endsWith(':batchUpdate'));
  const payload = JSON.parse(update.opts.body);
  assert.equal(payload.requests[0].insertText.text, 'world');
  assert.equal(payload.requests[0].insertText.location.index, 6);
});

test('calendar: create event builds dateTime and attendees; list passes bounds', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return jsonResponse({ id: 'evt-1', summary: 'Meeting' });
  }, async () => {
    const ev = await calendar.createEvent({
      summary: 'Meeting', start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z',
      timeZone: 'Europe/London', attendees: ['a@example.com'],
    });
    assert.equal(ev.id, 'evt-1');
    const listed = await calendar.listEvents({ timeMin: '2026-11-10T00:00:00Z', q: 'meeting' });
    assert.equal(listed.events.length, 0);
  });
  const createBody = JSON.parse(calls[0].opts.body);
  assert.equal(createBody.summary, 'Meeting');
  assert.equal(createBody.start.dateTime, '2026-11-10T10:00:00.000Z');
  assert.equal(createBody.start.timeZone, 'Europe/London');
  assert.equal(createBody.attendees[0].email, 'a@example.com');
  const list = new URL(calls[1].url);
  assert.equal(list.searchParams.get('q'), 'meeting');
  assert.equal(list.searchParams.get('singleEvents'), 'true');
});
