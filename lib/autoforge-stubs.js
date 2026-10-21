'use strict';

// Auto-Forge fallbacks — placeholders for pipeline steps that are not fully automated yet:
// stock footage and thumbnail generation. Each returns a REAL artifact on disk (so the later
// steps and the upload gate keep working) but the artifact is a stub. Every function is marked
// with a TODO so the real integrations are easy to find and replace.
//
// Nothing here is copied from the upstream skill pack; these are deliberately minimal.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');

/** A 1x1 solid-color PNG is not useful as a visible thumbnail; build a small SVG instead and
 *  persist it as `<slug>-thumbnail.svg`. Real thumbnail generation (image model / compositor)
 *  is a TODO. */
function placeholderThumbnailSvg({ title = '', width = 1280, height = 720, bg = '#1f6feb', fg = '#ffffff' } = {}) {
  const words = String(title || 'Untitled').replace(/[<>&]/g, '').split(/\s+/).slice(0, 4).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${bg}"/>
  <text x="64" y="${Math.round(height / 2)}" font-family="system-ui, sans-serif" font-size="72" font-weight="700" fill="${fg}">${words || 'Auto-Forge'}</text>
  <text x="64" y="${height - 56}" font-family="system-ui, sans-serif" font-size="28" fill="${fg}" opacity="0.7">Auto-Forge placeholder · TODO: real thumbnail</text>
</svg>\n`;
}

/**
 * Find stock footage for a topic.
 * TODO(auto-forge): integrate a real stock provider (Pexels / Pixabay / Storyblocks API) and
 * download the clips into the workspace. For now this returns a placeholder shot list.
 */
async function findStockFootage({ topic = '', workDir } = {}) {
  // TODO(auto-forge): replace with a real provider call + downloads.
  const shots = [
    { start: 0, end: 5, query: `${topic} establishing shot`, file: null, stub: true },
    { start: 5, end: 12, query: `${topic} b-roll`, file: null, stub: true },
    { start: 12, end: 20, query: `${topic} close-up`, file: null, stub: true },
  ];
  log.info('autoforge', 'stock footage is a placeholder — returning a stub shot list');
  return { shots, stub: true, todo: 'wire a real stock-footage provider (Pexels/Pixabay API)' };
}

/**
 * Create the video thumbnail.
 * TODO(auto-forge): render a real PNG (image model or SVG→PNG rasteriser) sized 1280x720.
 * For now this writes a placeholder SVG next to the other artifacts.
 */
async function generateThumbnail({ title = '', outPath, workDir } = {}) {
  const svg = placeholderThumbnailSvg({ title });
  let written = null;
  if (outPath) {
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, svg, 'utf8');
      written = outPath;
    } catch (e) { log.warn('autoforge', `could not write placeholder thumbnail to ${outPath}`, e); }
  }
  log.info('autoforge', 'thumbnail is a placeholder — wrote a stub SVG');
  return { thumbnail: written, format: 'svg', stub: true, todo: 'render a real 1280x720 PNG thumbnail' };
}

module.exports = { placeholderThumbnailSvg, findStockFootage, generateThumbnail };
