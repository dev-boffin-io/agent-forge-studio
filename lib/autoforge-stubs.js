'use strict';

// Auto-Forge content helpers — real integrations for the pipeline's media steps:
//   findStockFootage  — Pexels search + MP4 download into the workspace
//   generateThumbnail — a real 1280x720 PNG (see lib/png.js)
//
// Both degrade gracefully: when a provider/key is missing or a download fails, the function
// returns a clearly-marked stub (stub: true) so Auto-Forge never breaks — the caller marks the
// step 'skipped' rather than 'done'. Real output sets stub: false.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { Canvas, textWidth } = require('./png');
const { fetchOk } = require('./errors');

const PEXELS_SEARCH = 'https://api.pexels.com/videos/search';

/** Absolute workspace path for a relative artifact, falling back to the cwd when workDir is set. */
function absUnder(workDir, relPath) {
  const base = workDir || process.cwd();
  return path.isAbsolute(relPath) ? relPath : path.join(base, relPath);
}

function slugify(text) {
  return String(text || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
}

/** Pick the best-fitting video file for a shot: a small-ish MP4 in landscape if possible. */
function pickVideoFile(video) {
  const files = Array.isArray(video && video.video_files) ? video.video_files : [];
  const mp4 = files.filter((f) => (f.file_type || '').includes('mp4') || /\.mp4($|\?)/i.test(f.link || ''));
  const pool = mp4.length ? mp4 : files;
  if (!pool.length) return null;
  // prefer width >= 1280 but keep it modest to limit download size
  const ranked = pool.slice().sort((a, b) => {
    const score = (f) => (f.width >= 1280 ? 0 : 1000) + Math.abs((f.width || 0) - 1920);
    return score(a) - score(b);
  });
  return ranked[0];
}

/**
 * Search Pexels for clips and download them into `<workDir>/autoforge/<slug>/footage/`.
 * Returns a shot list [{file, start, end, query, stub}] and stub:false when at least one clip
 * was downloaded. `cfg` may carry: cfg.pexelsApiKey / cfg.PEXELS_API_KEY / cfg.stockFootage.
 *
 * @param {object} opts
 * @param {string} opts.topic
 * @param {string} [opts.workDir]
 * @param {object} [opts.cfg]
 * @param {number} [opts.count]  how many clips to fetch (default 4)
 * @param {number} [opts.perShot] seconds per shot when no duration is known (default 5)
 */
async function findStockFootage({ topic = '', workDir, cfg = {}, count = 4, perShot = 5 } = {}) {
  const key = (cfg && (cfg.pexelsApiKey || cfg.PEXELS_API_KEY)) || process.env.PEXELS_API_KEY || '';
  if (!key) {
    log.warn('autoforge', 'PEXELS_API_KEY not set — stock footage falls back to a stub');
    return stubShots(topic, 'set PEXELS_API_KEY (or cfg.pexelsApiKey) to download real clips');
  }

  const want = Math.max(1, Math.min(Number(count) || 4, 10));
  const orientation = (cfg.stockFootage && cfg.stockFootage.orientation) || 'landscape';

  let videos = [];
  try {
    const url = new URL(PEXELS_SEARCH);
    url.searchParams.set('query', String(topic || 'cinematic b-roll'));
    url.searchParams.set('per_page', String(want));
    url.searchParams.set('orientation', orientation);
    const res = await fetchOk(url.toString(), {
      headers: { Authorization: key },
      signal: cfg.signal,
    }, { source: 'pexels', where: 'api.pexels.com' });
    const body = await res.json();
    videos = Array.isArray(body.videos) ? body.videos : [];
  } catch (e) {
    log.warn('autoforge', 'Pexels search failed — falling back to a stub', e);
    return stubShots(topic, `Pexels search failed: ${e.message}`);
  }

  if (!videos.length) {
    log.warn('autoforge', `Pexels returned no videos for "${topic}" — falling back to a stub`);
    return stubShots(topic, 'Pexels returned no results');
  }

  const dirRel = path.join('autoforge', slugify(topic), 'footage');
  const dirAbs = absUnder(workDir, dirRel);
  fs.mkdirSync(dirAbs, { recursive: true });

  const shots = [];
  let cursor = 0;
  for (const v of videos) {
    const file = pickVideoFile(v);
    if (!file || !file.link) continue;
    const name = `clip-${String(shots.length + 1).padStart(2, '0')}.mp4`;
    const destAbs = path.join(dirAbs, name);
    try {
      const res = await fetchOk(file.link, { signal: cfg.signal }, { source: 'pexels', where: 'videos.pexels.com' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty download');
      fs.writeFileSync(destAbs, buf);
    } catch (e) {
      log.warn('autoforge', `could not download a Pexels clip (${name})`, e);
      continue;
    }
    const dur = Number(v.duration) > 0 ? Number(v.duration) : perShot;
    const len = Math.min(dur, perShot * 2);
    shots.push({
      file: path.relative(workDir || process.cwd(), destAbs),
      start: Number(cursor.toFixed(2)),
      end: Number((cursor + len).toFixed(2)),
      query: String(topic || ''),
      stub: false,
    });
    cursor += len;
    if (shots.length >= want) break;
  }

  if (!shots.length) {
    log.warn('autoforge', 'no Pexels clips could be downloaded — falling back to a stub');
    return stubShots(topic, 'no clips could be downloaded');
  }

  log.info('autoforge', `downloaded ${shots.length} stock clip(s) for "${topic}"`);
  return { shots, stub: false, provider: 'pexels', count: shots.length };
}

/** The graceful placeholder: a shot list with file:null so the render step knows to skip it. */
function stubShots(topic, reason) {
  const shots = [
    { start: 0, end: 5, query: `${topic} establishing shot`, file: null, stub: true },
    { start: 5, end: 12, query: `${topic} b-roll`, file: null, stub: true },
    { start: 12, end: 20, query: `${topic} close-up`, file: null, stub: true },
  ];
  return { shots, stub: true, reason, todo: 'set PEXELS_API_KEY to download real stock footage' };
}

/**
 * Wrap a title into up to 3 lines that fit the thumbnail width at the given scale.
 */
function wrapTitle(title, scale, maxWidth) {
  const words = String(title || 'AUTO-FORGE').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, scale) > maxWidth && cur) { lines.push(cur); cur = w; } else { cur = next; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/**
 * Produce a real 1280x720 PNG thumbnail (gradient background + wrapped title) at `outPath`.
 * Returns {thumbnail, format:'png', stub:false}. On failure, falls back to a stub result.
 */
async function generateThumbnail({ title = '', outPath, workDir, width = 1280, height = 720 } = {}) {
  const dest = outPath || path.join(absUnder(workDir, path.join('autoforge', 'thumbnail.png')));
  try {
    const canvas = new Canvas(width, height);
    canvas.fillGradient([31, 111, 235], [12, 32, 96]);
    // a bold colour bar so the thumbnail reads as a design, not a blank block
    canvas.fillRect(0, 0, width, 18, [255, 200, 0]);

    const pad = 72;
    const maxWidth = width - pad * 2;
    let scale = 12;
    let lines = wrapTitle(title || 'AUTO-FORGE', scale, maxWidth);
    while (lines.length > 1 && lines.some((l) => textWidth(l, scale) > maxWidth) && scale > 3) {
      scale -= 1;
      lines = wrapTitle(title || 'AUTO-FORGE', scale, maxWidth);
    }
    const lineH = 7 * scale + 12;
    const blockH = lines.length * lineH;
    let y = Math.round((height - blockH) / 2);
    for (const line of lines) {
      const lw = textWidth(line, scale);
      canvas.drawText(line, Math.round((width - lw) / 2), y, scale, [255, 255, 255]);
      y += lineH;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, canvas.toPng());
    log.info('autoforge', `wrote thumbnail PNG to ${dest}`);
    return { thumbnail: dest, format: 'png', width, height, stub: false };
  } catch (e) {
    log.warn('autoforge', 'thumbnail generation failed — writing an SVG placeholder instead', e);
    return {
      thumbnail: writeSvgFallback(dest, title),
      format: 'svg', stub: true,
      reason: `PNG generation failed: ${e.message}`,
    };
  }
}

/** Last-resort SVG written when the PNG encoder itself fails (kept for safety). */
function writeSvgFallback(outPath, title) {
  try {
    const svgPath = String(outPath).replace(/\.png$/i, '') + '.svg';
    const words = String(title || 'Untitled').replace(/[<>&]/g, '').split(/\s+/).slice(0, 4).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#1f6feb"/><text x="64" y="360" font-family="sans-serif" font-size="72" fill="#fff">${words}</text></svg>\n`;
    fs.mkdirSync(path.dirname(svgPath), { recursive: true });
    fs.writeFileSync(svgPath, svg, 'utf8');
    return svgPath;
  } catch { return null; }
}

module.exports = { findStockFootage, generateThumbnail, stubShots, slugify, pickVideoFile };
