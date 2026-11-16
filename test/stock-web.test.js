'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
setup();

const web = require('../lib/stock-web');

const PEXELS_HTML = `<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      videos: [{
        id: 42,
        width: 1920,
        height: 1080,
        duration: 10,
        title: 'Night in City',
        url: 'https://www.pexels.com/video/night-city-42/',
        tags: [{ name: 'city' }, { name: 'night' }],
        video_files: [
          { width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/42/42-4k.mp4' },
          { width: 1920, height: 1080, link: 'https://videos.pexels.com/video-files/42/42-hd.mp4' },
          { width: 640, height: 360, link: 'https://videos.pexels.com/video-files/42/42-sd.mp4' },
        ],
      }],
    },
  },
})}</script></body></html>`;

const PIXABAY_HTML = `<html><body>
<script type="application/json">${JSON.stringify({
  hits: [{
    id: 77,
    duration: 6,
    title: 'Coffee pour',
    tags: 'coffee, cafe',
    pageURL: 'https://pixabay.com/videos/id-77/',
    videos: {
      large: { url: 'https://cdn.pixabay.com/video/77-large.mp4', width: 1920, height: 1080 },
      small: { url: 'https://cdn.pixabay.com/video/77-small.mp4', width: 640, height: 360 },
    },
  }],
})}</script></body></html>`;

test('stock-web: parses Pexels __NEXT_DATA__ and records source/licence', () => {
  const out = web.parseStockPage(PEXELS_HTML, 'https://www.pexels.com/search/videos/city/', { orientation: 'landscape' });
  const rich = out.find((c) => c.title === 'Night in City');
  assert.ok(rich);
  assert.equal(rich.provider, 'pexels');
  assert.equal(rich.url, 'https://videos.pexels.com/video-files/42/42-hd.mp4');
  assert.equal(rich.width, 1920);
  assert.equal(rich.duration, 10);
  assert.equal(rich.pageUrl, 'https://www.pexels.com/video/night-city-42/');
  assert.equal(rich.license, 'Pexels License');
  assert.deepEqual(rich.tags, ['city', 'night']);
  assert.ok(out.length >= 1);
});

test('stock-web: parses Pixabay embedded JSON and picks a rendition', () => {
  const out = web.parseStockPage(PIXABAY_HTML, 'https://pixabay.com/videos/search/coffee/');
  const rich = out.find((c) => c.title === 'Coffee pour');
  assert.ok(rich);
  assert.equal(rich.provider, 'pixabay');
  assert.equal(rich.url, 'https://cdn.pixabay.com/video/77-large.mp4');
  assert.equal(rich.pageUrl, 'https://pixabay.com/videos/id-77/');
  assert.equal(rich.license, 'Pixabay Content License');
});

test('stock-web: bestRendition prefers 1080 on the short edge and respects orientation', () => {
  const files = [
    { url: 'https://videos.pexels.com/a-4k.mp4', width: 3840, height: 2160 },
    { url: 'https://videos.pexels.com/a-hd.mp4', width: 1920, height: 1080 },
    { url: 'https://videos.pexels.com/a-port.mp4', width: 1080, height: 1920 },
  ];
  assert.equal(web.bestRendition(files, { orientation: 'landscape', targetShort: 1080 }).url, 'https://videos.pexels.com/a-hd.mp4');
  assert.equal(web.bestRendition(files, { orientation: 'portrait', targetShort: 1080 }).url, 'https://videos.pexels.com/a-port.mp4');
  assert.equal(web.orientationOk(files[0], 'portrait'), false);
  assert.equal(web.bestRendition([], { orientation: 'portrait' }), null);
});

test('stock-web: direct URLs are recognised and resolved without a fetch', async () => {
  assert.equal(web.isDirectVideoUrl('https://cdn.pixabay.com/video/12.mp4?x=1'), true);
  assert.equal(web.isDirectVideoUrl('https://www.pexels.com/video/foo-123/'), false);
  assert.equal(web.providerFor('https://videos.pexels.com/x.mp4'), 'pexels');
  assert.equal(web.providerFor('https://cdn.pixabay.com/video/x.mp4'), 'pixabay');
  assert.equal(web.providerFor('https://example.com/x.mp4'), 'manual');

  const orig = global.fetch;
  global.fetch = async () => { throw new Error('must not fetch a direct media URL'); };
  try {
    const r = await web.resolveStockUrls({
      urls: ['https://cdn.pixabay.com/video/12.mp4'], want: 1, orientation: 'landscape',
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].provider, 'pixabay');
    assert.equal(r.candidates[0].license, 'Pixabay Content License');
  } finally {
    global.fetch = orig;
  }
});

test('stock-web: direct import refuses localhost/LAN URLs', async () => {
  const r = await web.resolveStockUrls({ urls: ['http://127.0.0.1/private.mp4'], want: 1 });
  assert.equal(r.candidates.length, 0);
  assert.match(r.errors[0], /private\/local/);
});

test('stock-web: paginated Pexels direct URLs are de-duplicated', () => {
  const html = PEXELS_HTML + '<img src="https://videos.pexels.com/video-files/42/42-hd.mp4">' +
    '<a href="https://cdn.pixabay.com/video/77-large.mp4">x</a>';
  const out = web.parseStockPage(html, 'https://www.pexels.com/search/videos/city/');
  assert.equal(out.filter((c) => c.url.includes('42-hd')).length, 1);
  assert.equal(out.filter((c) => c.url.includes('77-large')).length, 1);
  assert.equal(out.find((c) => c.url.includes('77-large')).license, 'Pixabay Content License');
});
