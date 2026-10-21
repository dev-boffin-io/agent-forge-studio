'use strict';

// chapters — YouTube chapters from a timestamped transcript. Ported faithfully from
// skills/yt-chapters/chapters.py (uses the shared transcript parser).
//
// Returns a description block you can paste straight under a video. YouTube's own rules, enforced
// here rather than assumed: the list must start at 00:00, needs at least three entries, and each
// chapter must be at least 10 seconds long. A block that breaks any of those silently does not
// become chapters, which is why this checks instead of trusting.
//
// Boundaries come from the gaps - the pauses you actually took between sections - scored by how long
// the pause was and how much the vocabulary changes across it. It is a first draft you retitle, not a
// summariser.

const { load, mmss } = require('./transcript');

const STOP = new Set('the a an of for to in on and or is are was were be been with this that it as at by from you your i my we our they them he she but so if then than there here what which who how when where why not no yes do does did just really very like about into over out up down can could will would should have has had get got make made go going went one two'.split(/\s+/));
const MIN = 10.0;

const keywords = (text) => new Set((String(text).toLowerCase().match(/[a-z']{4,}/g) || []).filter((w) => !STOP.has(w)));

/**
 * Draft chapters from loaded cues.
 * @param cues [{start,end,text}] from transcript.load()
 * @param opts {target} approximate number of chapters (default 7)
 */
function analyze(cues, { target = 7 } = {}) {
  if (!cues || cues.length < 6) return { error: 'too few cues to chapter' };
  const dur = cues[cues.length - 1].end;
  const cand = [];
  for (let i = 1; i < cues.length; i++) {
    const gap = cues[i].start - cues[i - 1].end;
    const before = cues.slice(Math.max(0, i - 12), i).map((c) => c.text).join(' ');
    const after = cues.slice(i, i + 12).map((c) => c.text).join(' ');
    const kb = keywords(before), ka = keywords(after);
    const uni = new Set([...kb, ...ka]);
    const shift = uni.size ? 1 - ([...kb].filter((w) => ka.has(w)).length / uni.size) : 0;
    cand.push({ score: gap * 1.6 + shift * 3.2, t: cues[i].start, i });
  }
  cand.sort((a, b) => b.score - a.score);
  const picked = [0.0];
  for (const { t } of cand) {
    if (picked.length >= target) break;
    if (picked.every((p) => Math.abs(t - p) >= MIN) && dur - t >= MIN) picked.push(t);
  }
  picked.sort((a, b) => a - b);
  const chapters = [];
  for (let n = 0; n < picked.length; n++) {
    const t = picked[n];
    const end = n + 1 < picked.length ? picked[n + 1] : dur;
    const text = cues.filter((c) => c.start >= t && c.end <= end).map((c) => c.text).join(' ');
    const counts = new Map();
    for (const w of keywords(text)) counts.set(w, text.toLowerCase().split(w).length - 1);
    const kw = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, 3);
    const title = kw.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Section';
    chapters.push({ start: +t.toFixed(2), label: mmss(t), draft_title: title, seconds: +(end - t).toFixed(2) });
  }
  const valid = chapters.length >= 3 && chapters[0].start === 0 && chapters.every((c) => c.seconds >= MIN);
  return { valid, chapters, note: valid ? '' : 'INVALID: YouTube needs 3+, a 00:00 first entry and 10s minimum each' };
}

/** convenience: load a transcript file and draft chapters */
function analyzeFile(file, opts = {}) {
  return analyze(load(file), opts);
}

module.exports = { analyze, analyzeFile, MIN };
