'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const g = require('../lib/google');
const photos = require('../lib/google/photos');
const picker = require('../lib/google/photos-picker');

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

function textResponse(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/plain' },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.from(text),
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

test('photos: OAuth scopes include Library and Picker access', () => {
  for (const scope of [
    'https://www.googleapis.com/auth/photoslibrary.appendonly',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
    'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata',
    'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  ]) {
    assert.ok(g.SCOPES.includes(scope), `missing ${scope}`);
  }
});

test('photos: upload sends raw bytes then creates a media item', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/uploads')) return textResponse('upload-token-1');
    return jsonResponse({
      newMediaItemResults: [{
        uploadToken: 'upload-token-1',
        status: { message: 'Success' },
        mediaItem: { id: 'm1', filename: 'a.jpg', mimeType: 'image/jpeg', productUrl: 'https://photos.example/m1' },
      }],
    });
  }, async () => {
    const token = await photos.uploadBytes({ bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' });
    assert.equal(token, 'upload-token-1');

    const created = await photos.createMediaItem({
      uploadToken: token, fileName: 'a.jpg', description: 'Trip', albumId: 'album-1',
    });
    assert.equal(created.item.id, 'm1');
    assert.equal(created.item.productUrl, 'https://photos.example/m1');
  });

  assert.equal(calls[0].url, 'https://photoslibrary.googleapis.com/v1/uploads');
  assert.equal(calls[0].opts.headers['content-type'], 'application/octet-stream');
  assert.equal(calls[0].opts.headers['x-goog-upload-content-type'], 'image/jpeg');
  assert.equal(calls[0].opts.headers['x-goog-upload-protocol'], 'raw');
  assert.equal(Buffer.from(calls[0].opts.body).toString(), 'jpeg-bytes');

  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.albumId, 'album-1');
  assert.equal(body.newMediaItems[0].description, 'Trip');
  assert.equal(body.newMediaItems[0].simpleMediaItem.fileName, 'a.jpg');
  assert.equal(body.newMediaItems[0].simpleMediaItem.uploadToken, 'upload-token-1');
});

test('photos: list, search by album, and album management', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/mediaItems:search')) return jsonResponse({ mediaItems: [{ id: 'm2' }] });
    if (String(url).includes(':batchAddMediaItems')) return jsonResponse({});
    if (String(url).includes(':batchRemoveMediaItems')) return jsonResponse({});
    if (String(url).endsWith('/albums') && opts.method === 'POST') return jsonResponse({ id: 'a2', title: 'New album' });
    if (String(url).includes('/albums?')) return jsonResponse({ albums: [{ id: 'a1', title: 'Trip' }] });
    return jsonResponse({ mediaItems: [{ id: 'm1' }], nextPageToken: 'next-1' });
  }, async () => {
    const listed = await photos.listMediaItems({ pageSize: 10 });
    assert.equal(listed.mediaItems[0].id, 'm1');
    assert.equal(listed.nextPageToken, 'next-1');

    const albumItems = await photos.listMediaItems({ albumId: 'a1', pageSize: 5 });
    assert.equal(albumItems.mediaItems[0].id, 'm2');

    const albums = await photos.listAlbums({ pageSize: 5 });
    assert.equal(albums.albums[0].title, 'Trip');

    const created = await photos.createAlbum({ title: 'New album' });
    assert.equal(created.album.id, 'a2');

    const added = await photos.addMediaItemsToAlbum({ albumId: 'a1', mediaItemIds: ['m1', 'm2'] });
    assert.equal(added.ok, true);
    const removed = await photos.removeMediaItemsFromAlbum({ albumId: 'a1', mediaItemIds: ['m1'] });
    assert.equal(removed.ok, true);
  });

  const list = new URL(calls[0].url);
  assert.equal(list.searchParams.get('pageSize'), '10');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer access-1');

  const search = calls.find((c) => c.url.includes('/mediaItems:search'));
  assert.equal(JSON.parse(search.opts.body).albumId, 'a1');
  assert.equal(JSON.parse(search.opts.body).pageSize, 5);

  const albumList = calls.find((c) => c.url.includes('/albums?'));
  assert.equal(new URL(albumList.url).searchParams.get('excludeNonAppCreatedData'), 'true');

  const add = calls.find((c) => c.url.includes(':batchAddMediaItems'));
  assert.deepEqual(JSON.parse(add.opts.body).mediaItemIds, ['m1', 'm2']);
});

test('photos: download fetches baseUrl with the photo download parameter', async () => {
  const calls = [];
  await withMockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('/mediaItems/m1')) {
      return jsonResponse({ id: 'm1', filename: 'a.jpg', mimeType: 'image/jpeg', baseUrl: 'https://lh3.example/x', productUrl: 'https://photos.example/m1' });
    }
    return bufferResponse(Buffer.from('photo-bytes'), 'image/jpeg');
  }, async () => {
    const out = await photos.downloadMediaItem({ mediaItemId: 'm1' });
    assert.equal(out.buffer.toString(), 'photo-bytes');
    assert.equal(out.contentType, 'image/jpeg');
    assert.equal(out.mediaItem.id, 'm1');
  });
  assert.equal(calls[0], 'https://photoslibrary.googleapis.com/v1/mediaItems/m1');
  assert.equal(calls[1], 'https://lh3.example/x=d');
});

test('photos: picker creates a session, lists picks, and downloads them', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/sessions') && opts.method === 'POST') {
      return jsonResponse({
        id: 's1', pickerUri: 'https://photos.example/pick/s1', mediaItemsSet: false,
        pollingConfig: { pollInterval: '0s', timeoutIn: '3600s' },
      });
    }
    if (String(url).endsWith('/sessions/s1') && opts.method === 'GET') {
      return jsonResponse({ id: 's1', pickerUri: 'https://photos.example/pick/s1', mediaItemsSet: true });
    }
    if (String(url).includes('/mediaItems?') && String(url).includes('photospicker')) {
      return jsonResponse({
        mediaItems: [{
          id: 'p1', type: 'PHOTO', createTime: '2026-01-01T00:00:00Z',
          mediaFile: { baseUrl: 'https://lh3.example/p', mimeType: 'image/jpeg', filename: 'p.jpg' },
        }],
      });
    }
    if (String(url).startsWith('https://lh3.example/p')) return bufferResponse(Buffer.from('picked-bytes'), 'image/jpeg');
    if (String(url).endsWith('/sessions/s1') && opts.method === 'DELETE') return jsonResponse({});
    return jsonResponse({});
  }, async () => {
    const session = await picker.createSession({ maxItemCount: 3 });
    assert.equal(session.id, 's1');
    assert.match(session.pickerUri, /pick\/s1/);

    const waited = await picker.waitForSelection({ sessionId: 's1' });
    assert.equal(waited.mediaItemsSet, true);
    assert.equal(waited.timedOut, false);

    const listed = await picker.listMediaItems({ sessionId: 's1', pageSize: 10 });
    assert.equal(listed.mediaItems[0].mediaFile.filename, 'p.jpg');

    const downloaded = await picker.downloadMediaItem({ sessionId: 's1', mediaItemId: 'p1' });
    assert.equal(downloaded.buffer.toString(), 'picked-bytes');
    assert.equal(downloaded.mediaItem.id, 'p1');

    const deleted = await picker.deleteSession({ sessionId: 's1' });
    assert.equal(deleted.ok, true);
  });

  const create = calls.find((c) => c.url.endsWith('/sessions') && c.opts.method === 'POST');
  assert.equal(JSON.parse(create.opts.body).pickingConfig.maxItemCount, '3');

  const list = calls.find((c) => c.url.includes('/mediaItems?') && c.url.includes('photospicker'));
  assert.equal(new URL(list.url).searchParams.get('sessionId'), 's1');
  assert.equal(new URL(list.url).searchParams.get('pageSize'), '10');

  assert.ok(calls.some((c) => c.url === 'https://lh3.example/p=d'));
  assert.ok(calls.some((c) => c.url.endsWith('/sessions/s1') && c.opts.method === 'DELETE'));
});
