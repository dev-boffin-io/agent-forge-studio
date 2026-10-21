'use strict';

// Auto-Forge content helpers — real integrations for the pipeline's media steps:
//   findStockFootage  — multi-provider stock-footage cascade (see lib/stock.js)
//   generateThumbnail — a real 1280x720 PNG (see lib/png.js)
//
// Both degrade gracefully: when a provider/key is missing or a download fails, the function
// returns a clearly-marked stub (stub: true) so Auto-Forge never breaks — the caller marks the
// step 'skipped' rather than 'done'. Real output sets stub: false.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { Canvas, textWidth } = require('./png');
const stock = require('./stock');

const { findStockFootage, stubShots, slugify } = stock;

/** Absolute workspace path for a relative artifact, falling back to the cwd when workDir is set. */
function absUnder(workDir, relPath) {
  const base = workDir || process.cwd();
  return path.isAbsolute(relPath) ? relPath : path.join(base, relPath);
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

module.exports = { findStockFootage, generateThumbnail, stubShots, slugify };
