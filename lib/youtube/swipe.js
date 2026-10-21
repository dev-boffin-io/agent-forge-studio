'use strict';

// swipe — rank collected videos by how far each beat its OWN channel, then name the formula.
// Ported faithfully from skills/yt-viral/swipe.py (formulas from lib/youtube/hooks.json).
//
// Input is a list you collected - one object per video:
//   [{channel:"Some Channel", title:"...", views:412000, url:"...", duration:613}, ...]
//
// Raw view counts rank channel size, not ideas. A 400k video on a 2M-subscriber channel is a normal
// Tuesday; a 400k video on a channel whose median is 30k is the thing worth studying. So every video
// is scored as a MULTIPLE OF ITS OWN CHANNEL'S MEDIAN, which needs at least four videos per channel
// to mean anything - the tool says so rather than quietly ranking on noise.
//
// The formula comes from hooks.json, matched against the TITLE. It is a judgement about the words on
// screen, not a claim about why the video worked.

const { hooks: FORMULAS } = require('./hooks.json');

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function classify(title) {
  const scored = [];
  for (const f of FORMULAS) {
    let n = 0;
    for (const p of f.match) if (new RegExp(p, 'i').test(title)) n++;
    if (n) scored.push([n, f.name]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.length ? scored[0][1] : 'Unclassified';
}

/**
 * Rank a collected list.
 * @param rows [{channel,title,views,url?}]
 * @param opts {min} minimum multiple of own-channel median to count as an outlier (default 1.5)
 */
function analyze(rows, { min = 1.5 } = {}) {
  if (!Array.isArray(rows)) rows = (rows && rows.videos) || [];
  const by = new Map();
  for (const r of rows) {
    const ch = (r && r.channel) || '?';
    if (!by.has(ch)) by.set(ch, []);
    by.get(ch).push(r || {});
  }
  const out = [], thin = [];
  for (const [ch, vids] of by) {
    const views = vids.map((v) => Number(v.views) || 0);
    const med = median(views);
    if (vids.length < 4) { thin.push({ channel: ch, n: vids.length }); continue; }
    for (const v of vids) {
      const m = med ? (Number(v.views) || 0) / med : 0;
      out.push({
        channel: ch, title: v.title || '', views: Number(v.views) || 0, median: Math.round(med),
        multiple: +m.toFixed(2), formula: classify(v.title || ''), url: v.url || '',
      });
    }
  }
  const kept = out.filter((r) => r.multiple >= min).sort((a, b) => b.multiple - a.multiple);
  const counts = new Map();
  for (const r of kept) counts.set(r.formula, (counts.get(r.formula) || 0) + 1);
  return {
    total_videos: rows.length, total_channels: by.size, min,
    outliers: kept,
    skipped_thin_channels: thin,
    formula_counts: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([formula, n]) => ({ formula, n })),
  };
}

module.exports = { analyze, classify, median };
