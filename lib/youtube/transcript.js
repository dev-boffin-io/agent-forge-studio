'use strict';

// Shared transcript parser for SRT, WebVTT and whisper JSON — one implementation, used by the
// edit-list (deadair), chapter and retention analyzers. Ported faithfully from the original
// Python tools (skills/yt-edit/deadair.py::load).

const fs = require('node:fs');
const path = require('node:path');

/** "HH:MM:SS,mmm" | "HH:MM:SS.mmm" | "MM:SS.mmm" -> seconds */
function parseTs(s) {
  const t = String(s).trim().replace(',', '.');
  const p = t.split(':').map((x) => x.trim());
  if (p.length === 3) return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseFloat(p[2]);
  if (p.length === 2) return parseInt(p[0], 10) * 60 + parseFloat(p[1]);
  return parseFloat(p[0]);
}

const CUE_RE = /\s*(\d[\d:.,]+)\s*-->\s*(\d[\d:.,]+)/;

/**
 * Load cues from an SRT / VTT / whisper-JSON file (or its text).
 * @returns [{start, end, text}]  — end > start, text non-empty
 */
function load(fileOrText, isPath = true) {
  const raw = isPath ? fs.readFileSync(fileOrText, 'utf8') : String(fileOrText || '');
  const file = isPath ? fileOrText : '';
  if (/\.json$/i.test(file) || (!isPath && raw.trimStart().startsWith('{')) || (!isPath && raw.trimStart().startsWith('['))) {
    let d;
    try { d = JSON.parse(raw); } catch { return []; }
    const segs = Array.isArray(d) ? d : (Array.isArray(d.segments) ? d.segments : []);
    const out = [];
    for (const s of segs) {
      if (s == null || typeof s !== 'object') continue;
      const start = Number(s.start), end = Number(s.end);
      const text = String(s.text == null ? '' : s.text).trim();
      if (Number.isFinite(start) && Number.isFinite(end) && text) out.push({ start, end, text });
    }
    return out;
  }
  const cues = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = CUE_RE.exec(line);
    if (m) {
      cur = [parseTs(m[1]), parseTs(m[2]), []];
      cues.push(cur);
    } else if (cur != null && line.trim() && !/^\d+$/.test(line.trim())) {
      // VTT cue settings after the end timestamp ("align:start position:0%") never reach here:
      // they sit on the --> line, which the regex already consumed up to the end timestamp.
      cur[2].push(line.trim());
    }
  }
  return cues.filter(([, , t]) => t.length).map(([start, end, t]) => ({ start, end, text: t.join(' ') }));
}

const mmss = (t) => {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

module.exports = { parseTs, load, mmss };
