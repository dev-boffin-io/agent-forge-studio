'use strict';

// retention — read a YouTube Studio audience-retention export and find the leaks. Ported faithfully
// from skills/yt-retention/retention.py (uses the shared transcript parser when a transcript is given).
//
// Get the file from Studio: Analytics -> a video -> Engagement -> the audience-retention chart ->
// the download icon -> "Audience retention". Two columns, a position (percent or seconds) and a
// percentage still watching.
//
// It reports three things, because they are three different problems with three different fixes:
//   HOOK LEAK    what you lost in the first 30 seconds
//   CLIFFS       single steep drops - a specific moment people left at
//   SLIDE        the steady bleed rate across the flat middle
//
// With a transcript it reports what you were saying at each cliff, which is the only version of this
// report you can act on without scrubbing the video yourself.

const fs = require('node:fs');
const { load } = require('./transcript');

function loadCsv(file) {
  const rows = [];
  const raw = fs.readFileSync(file, 'utf8');
  // strip BOM; split lines; naive comma/semicolon/tab split is enough for this two-column export
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const nums = [];
    for (const c of line.split(/[,;\t]/)) {
      const s = c.trim().replace('%', '').replace(/,/g, '').replace(/^"|"$/g, '');
      const f = Number(s);
      nums.push(s !== '' && Number.isFinite(f) ? f : null);
    }
    const vals = nums.filter((n) => n != null);
    if (vals.length >= 2) rows.push([vals[0], vals[1]]);
  }
  return rows;
}

/**
 * Analyze a retention CSV.
 * @param file path to the CSV
 * @param opts {duration, transcript} — duration in seconds (needed when the x-axis is a percent),
 *   optional transcript path for "said at cliff"
 */
function analyze(file, { duration: dur = null, transcript = null } = {}) {
  const rows = loadCsv(file);
  if (rows.length < 8) return { error: 'could not read at least 8 data points from that csv' };
  const xs = rows.map((r) => r[0]);
  const ys = rows.map((r) => r[1]);
  const pctAxis = Math.max(...xs) <= 100.5;
  const at = (x) => (pctAxis && dur ? (x / 100.0) * dur : x);
  const start = ys[0] || 100.0;
  // HOOK: the first 30 seconds, or the first 10% when the axis is a percentage and we have no duration
  const cutoff = !pctAxis ? 30.0 : (dur ? (30.0 / dur) * 100 : 10.0);
  let hookEnd = start;
  for (const [x, y] of rows) if (x <= cutoff && y < hookEnd) hookEnd = y;
  const hook_leak = start - hookEnd;
  const drops = [];
  for (let i = 1; i < rows.length; i++) {
    const d = ys[i - 1] - ys[i];
    const span = xs[i] - xs[i - 1] || 1;
    drops.push({ rate: d / span, x0: xs[i - 1], x1: xs[i], d });
  }
  drops.sort((a, b) => b.rate - a.rate);
  const cliffs = drops.filter((r) => r.d > 0.8).slice(0, 5).map((r) => ({
    from: +r.x0.toFixed(2), to: +r.x1.toFixed(2), lost: +r.d.toFixed(2),
    at_seconds: !pctAxis || dur ? +at(r.x0).toFixed(1) : null,
  }));
  const mid = drops.filter((r) => r.x0 > cutoff).map((r) => r.rate);
  const slide = mid.length ? mid.reduce((a, b) => a + b, 0) / mid.length : 0;
  const said = {};
  if (transcript) {
    const cues = load(transcript);
    for (const c of cliffs) {
      if (c.at_seconds == null) continue;
      const t = c.at_seconds;
      const near = cues.filter((q) => q.start <= t + 4 && q.end >= t - 4).map((q) => q.text).join(' ');
      said[String(c.from)] = near.slice(0, 140);
    }
  }
  const verdict = hook_leak < 25 ? 'healthy' : hook_leak < 40 ? 'leaking' : 'severe';
  return {
    points: rows.length, start: +start.toFixed(1), hook_leak: +hook_leak.toFixed(2), verdict,
    end: +ys[ys.length - 1].toFixed(1), cliffs, slide_per_unit: +slide.toFixed(3), said,
  };
}

module.exports = { analyze, loadCsv };
