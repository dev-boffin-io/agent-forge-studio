'use strict';

// Stock-footage cascade — the provider parsers and the Pexels → Pixabay → stub fallback
// sequence. Network is mocked by replacing global.fetch, so no keys are required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setup } = require('./helpers');
setup();

const stock = require('../lib/stock');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stock-')); }

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)).buffer,
  };
}

function clipResponse(bytes) {
  return {
    ok: true, status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
    json: async () => ({}),
  };
}

const PEXELS_BODY = {
  videos: [
    { id: 1, duration: 8, video_files: [{ file_type: 'video/mp4', width: 1920, link: 'https://videos.pexels.com/a.mp4' }] },
    { id: 2, duration: 6, video_files: [{ file_type: 'video/mp4', width: 1280, link: 'https://videos.pexels.com/b.mp4' }] },
  ],
};

const PIXABAY_BODY = {
  total: 2, totalHits: 2,
  hits: [
    { id: 10, duration: 12, tags: 'coffee', videos: { large: { url: 'https://cdn.pixabay.com/a_large.mp4', width: 1920 }, medium: { url: 'https://cdn.pixabay.com/a_medium.mp4', width: 1280 } } },
    { id: 11, duration: 5, tags: 'cup', videos: { small: { url: 'https://cdn.pixabay.com/b_small.mp4', width: 640 } } },
  ],
};

// Real Wikimedia Commons shape: query.pages is an object keyed by pageid, each with imageinfo.
const WIKIMEDIA_BODY = {
  batchcomplete: '',
  query: {
    pages: {
      81916645: {
        pageid: 81916645, ns: 6, title: 'File:Ocean in Sommaroy.webm',
        imageinfo: [{ size: 2928602, width: 1920, height: 1080, duration: 15.472, url: 'https://upload.wikimedia.org/wikipedia/commons/5/5d/Ocean_in_Sommaroy.webm', mime: 'video/webm' }],
      },
      146189041: {
        pageid: 146189041, ns: 6, title: 'File:Chemical Pollution of the Ocean.webm',
        imageinfo: [{ size: 24312520, width: 1280, height: 720, duration: 83, url: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Chemical_Pollution_of_the_Ocean.webm', mime: 'video/webm' }],
      },
    },
  },
};

// ---- Pixabay parser -------------------------------------------------------------------------

test('stock: parsePixabay extracts the best rendition per hit', () => {
  const out = stock.parsePixabay(PIXABAY_BODY);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://cdn.pixabay.com/a_large.mp4');
  assert.equal(out[0].width, 1920);
  assert.equal(out[0].duration, 12);
  assert.equal(out[1].url, 'https://cdn.pixabay.com/b_small.mp4');
});

test('stock: parsePixabay skips hits with no usable rendition and tolerates junk', () => {
  assert.deepEqual(stock.parsePixabay({ hits: [{ id: 1, videos: {} }, { id: 2 }] }), []);
  assert.deepEqual(stock.parsePixabay(null), []);
  assert.deepEqual(stock.parsePixabay({}), []);
});

test('stock: pickPixabayFile prefers the largest available size', () => {
  const both = stock.pickPixabayFile({ videos: { medium: { url: 'm.mp4', width: 1280 }, large: { url: 'l.mp4', width: 1920 } } });
  assert.equal(both.url, 'l.mp4');
  const onlyTiny = stock.pickPixabayFile({ videos: { tiny: { url: 't.mp4', width: 480 } } });
  assert.equal(onlyTiny.url, 't.mp4');
  assert.equal(stock.pickPixabayFile({ videos: {} }), null);
});

test('stock: parsePexels extracts downloadable mp4 candidates', () => {
  const out = stock.parsePexels(PEXELS_BODY);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://videos.pexels.com/a.mp4');
  assert.equal(out[0].width, 1920);
  assert.equal(out[0].duration, 8);
});

// ---- Wikimedia parser -----------------------------------------------------------------------

test('stock: parseWikimedia extracts video candidates from query.pages', () => {
  const out = stock.parseWikimedia(WIKIMEDIA_BODY);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://upload.wikimedia.org/wikipedia/commons/5/5d/Ocean_in_Sommaroy.webm');
  assert.equal(out[0].width, 1920);
  assert.equal(out[0].duration, 15.472);
  assert.equal(out[0].ext, 'webm');
});

test('stock: parseWikimedia tolerates junk, empty and non-video imageinfo', () => {
  assert.deepEqual(stock.parseWikimedia(null), []);
  assert.deepEqual(stock.parseWikimedia({}), []);
  assert.deepEqual(stock.parseWikimedia({ query: { pages: {} } }), []);
  const imageOnly = { query: { pages: { 1: { imageinfo: [{ url: 'https://x/a.jpg', mime: 'image/jpeg', width: 800 }] } } } };
  assert.deepEqual(stock.parseWikimedia(imageOnly), []);
});

test('stock: pickWikimediaFile prefers an mp4 rendition over webm neighbours', () => {
  const info = [
    { url: 'https://x/a.webm', mime: 'video/webm', width: 1920, duration: 10 },
    { url: 'https://x/a.mp4', mime: 'video/mp4', width: 1280, duration: 10 },
  ];
  assert.equal(stock.pickWikimediaFile(info).url, 'https://x/a.mp4');
  assert.equal(stock.pickWikimediaFile([{ url: 'https://x/a.webm', mime: 'video/webm', width: 1920 }]).url, 'https://x/a.webm');
  assert.equal(stock.pickWikimediaFile([]), null);
});

// ---- cascade sequence -----------------------------------------------------------------------

test('stock: no keys and Wikimedia unreachable → stub with an informative todo, never throws', async () => {
  await withMockFetch(async (url) => {
    if (String(url).includes('commons.wikimedia.org')) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({}) };
    return clipResponse(Buffer.from('x'));
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: tmpDir(), cfg: {} });
    assert.equal(r.stub, true);
    assert.ok(r.shots.every((s) => s.file === null && s.stub === true));
    assert.ok(r.todo.includes('PEXELS_API_KEY') && r.todo.includes('PIXABAY_API_KEY'));
    assert.match(r.reason, /no API key/i);
    assert.match(r.reason, /Wikimedia/);
  });
});

test('stock: Pexels is used first and wins when it returns clips', async () => {
  const dirT = tmpDir();
  const bytes = Buffer.from('PEXELS-CLIP');
  const hosts = [];
  await withMockFetch(async (url) => {
    const u = String(url);
    hosts.push(new URL(u).host);
    if (u.includes('api.pexels.com')) return jsonResponse(PEXELS_BODY);
    if (u.includes('pixabay.com')) return jsonResponse(PIXABAY_BODY);
    return clipResponse(bytes);
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'pexels');
    assert.equal(r.shots.length, 2);
    assert.ok(r.shots.every((s) => fs.existsSync(path.join(dirT, s.file))));
    assert.ok(!hosts.includes('pixabay.com'), 'Pixabay is never queried once Pexels succeeds');
  });
});

test('stock: missing Pexels key falls through to Pixabay', async () => {
  const dirT = tmpDir();
  const bytes = Buffer.from('PIXABAY-CLIP');
  const hosts = [];
  await withMockFetch(async (url) => {
    const u = String(url);
    hosts.push(new URL(u).host);
    if (u.includes('pixabay.com')) return jsonResponse(PIXABAY_BODY);
    return clipResponse(bytes);
  }, async () => {
    // only the Pixabay key is set
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pixabayApiKey: 'bk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'pixabay');
    assert.equal(r.shots.length, 2);
    assert.ok(r.shots.every((s) => fs.existsSync(path.join(dirT, s.file))));
    assert.ok(hosts.includes('pixabay.com'));
    assert.ok(!hosts.includes('api.pexels.com'), 'Pexels is skipped without a key');
  });
});

test('stock: a Pexels 429 falls through to Pixabay', async () => {
  const dirT = tmpDir();
  const bytes = Buffer.from('PIXABAY-CLIP');
  await withMockFetch(async (url) => {
    const u = String(url);
    if (u.includes('api.pexels.com')) return { ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) };
    if (u.includes('pixabay.com')) return jsonResponse(PIXABAY_BODY);
    return clipResponse(bytes);
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'pixabay');
  });
});

test('stock: a Pexels empty result falls through to Pixabay', async () => {
  const dirT = tmpDir();
  const bytes = Buffer.from('PIXABAY-CLIP');
  await withMockFetch(async (url) => {
    const u = String(url);
    if (u.includes('api.pexels.com')) return jsonResponse({ videos: [] });
    if (u.includes('pixabay.com')) return jsonResponse(PIXABAY_BODY);
    return clipResponse(bytes);
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'pixabay');
  });
});

test('stock: both providers fail → stub (no throw) with both reasons recorded', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    const u = String(url);
    if (u.includes('api.pexels.com')) return { ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) };
    if (u.includes('pixabay.com')) return { ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) };
    return clipResponse(Buffer.from('x'));
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' } });
    assert.equal(r.stub, true);
    assert.ok(r.shots.every((s) => s.file === null));
    assert.match(r.reason, /Pexels/);
    assert.match(r.reason, /Pixabay/);
  });
});

// ---- Wikimedia keyless path -----------------------------------------------------------------

test('stock: with no keys, Wikimedia Commons is used and returns real clips', async () => {
  const dirT = tmpDir();
  const bytes = Buffer.from('WIKIMEDIA-CLIP');
  const hosts = [];
  await withMockFetch(async (url) => {
    const u = String(url);
    hosts.push(new URL(u).host);
    if (u.includes('commons.wikimedia.org')) return jsonResponse(WIKIMEDIA_BODY);
    return clipResponse(bytes);
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'ocean', workDir: dirT, cfg: {}, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'wikimedia');
    assert.equal(r.count, 2);
    assert.ok(r.shots.every((s) => fs.existsSync(path.join(dirT, s.file))));
    assert.ok(r.shots.every((s) => s.provider === 'wikimedia'));
    assert.ok(!hosts.includes('api.pexels.com') && !hosts.includes('pixabay.com'), 'keyed providers are skipped');
  });
});

test('stock: Wikimedia sends the required User-Agent and a filetype:video query', async () => {
  const dirT = tmpDir();
  let seen = null;
  await withMockFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes('commons.wikimedia.org')) {
      seen = { u, ua: (opts && opts.headers && (opts.headers['User-Agent'] || opts.headers['user-agent'])) || null };
      return jsonResponse(WIKIMEDIA_BODY);
    }
    return clipResponse(Buffer.from('CLIP'));
  }, async () => {
    await stock.findStockFootage({ topic: 'ocean waves', workDir: dirT, cfg: {}, count: 2 });
    assert.ok(seen, 'the Commons API was queried');
    assert.match(seen.u, /gsrsearch=filetype%3Avideo/);
    assert.match(seen.u, /gsrnamespace=6/);
    assert.ok(seen.ua && /YouTubeForgeStudio/.test(seen.ua), 'User-Agent identifies the client');
  });
});

test('stock: Wikimedia clips are saved with their real extension (webm)', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    if (String(url).includes('commons.wikimedia.org')) return jsonResponse(WIKIMEDIA_BODY);
    return clipResponse(Buffer.from('CLIP'));
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'ocean', workDir: dirT, cfg: {}, count: 1 });
    assert.equal(r.provider, 'wikimedia');
    assert.match(r.shots[0].file, /wikimedia-01\.webm$/);
    assert.ok(fs.existsSync(path.join(dirT, r.shots[0].file)));
  });
});

test('stock: Pexels and Pixabay both fail → Wikimedia wins (cascade order)', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    const u = String(url);
    if (u.includes('api.pexels.com')) return { ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) };
    if (u.includes('pixabay.com')) return { ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) };
    if (u.includes('commons.wikimedia.org')) return jsonResponse(WIKIMEDIA_BODY);
    return clipResponse(Buffer.from('CLIP'));
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'ocean', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.equal(r.provider, 'wikimedia');
  });
});

test('stock: all three providers fail → stub (cascade order ends at fallback)', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    const u = String(url);
    if (u.includes('commons.wikimedia.org')) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({}) };
    return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'ocean', workDir: dirT, cfg: { pexelsApiKey: 'pk', pixabayApiKey: 'bk' } });
    assert.equal(r.stub, true);
    assert.match(r.reason, /Pexels/);
    assert.match(r.reason, /Pixabay/);
    assert.match(r.reason, /Wikimedia/);
  });
});

test('stock: a Wikimedia network error is caught and falls through to the stub', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    if (String(url).includes('commons.wikimedia.org')) throw new Error('ENOTFOUND commons.wikimedia.org');
    return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'ocean', workDir: dirT, cfg: {} });
    assert.equal(r.stub, true);
    assert.match(r.reason, /Wikimedia/);
  });
});

test('stock: candidate downloads are named per provider and get sequential timing', async () => {
  const dirT = tmpDir();
  await withMockFetch(async (url) => {
    if (String(url).includes('api.pexels.com')) return jsonResponse(PEXELS_BODY);
    return clipResponse(Buffer.from('CLIP'));
  }, async () => {
    const r = await stock.findStockFootage({ topic: 'coffee brewing', workDir: dirT, cfg: { pexelsApiKey: 'pk' }, count: 2 });
    assert.equal(r.stub, false);
    assert.match(r.shots[0].file, /pexels-01\.mp4$/);
    assert.equal(r.shots[0].start, 0);
    assert.ok(r.shots[1].start >= r.shots[0].end, 'shots are laid out sequentially');
  });
});

test('stock: environment variables are honoured when cfg has no key', async () => {
  const dirT = tmpDir();
  const prev = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = 'env-key';
  try {
    await withMockFetch(async (url) => {
      const u = String(url);
      const host = new URL(u).host;
      if (host === 'pixabay.com') {
        assert.ok(u.includes('key=env-key'), 'env key used in the request');
        return jsonResponse(PIXABAY_BODY);
      }
      return clipResponse(Buffer.from('CLIP'));
    }, async () => {
      const r = await stock.findStockFootage({ topic: 'coffee', workDir: dirT, cfg: {} });
      assert.equal(r.stub, false);
      assert.equal(r.provider, 'pixabay');
    });
  } finally {
    if (prev === undefined) delete process.env.PIXABAY_API_KEY; else process.env.PIXABAY_API_KEY = prev;
  }
});
