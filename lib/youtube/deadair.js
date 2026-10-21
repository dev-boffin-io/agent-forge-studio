'use strict';

// deadair — an edit decision list from a timestamped transcript. Ported faithfully from
// skills/yt-edit/deadair.py (uses the shared transcript parser).
//
// Finds three things and returns the cuts as a list you can act on, oldest problem first after
// sorting by start time:
//   DEAD    gaps between spoken cues longer than the floor
//   FILLER  cues that are only filler ("um", "so yeah", "basically")
//   REPEAT  a sentence restarted - the second take of the same opening
//
// WHAT IT DOES NOT DO. It does not cut the file. It returns an EDL, the total it would remove, and
// the runtime you would land on; you apply it in whatever editor you use. Nothing here touches media.

const { load } = require('./transcript');

const FILLER_ONLY = /^[\s,.-]*((um+|uh+|er+|ah+|so|okay|ok|right|yeah|like|anyway|basically|actually|you know|i mean|let me see|hold on)[\s,.-]*)+$/i;

const norm = (t) => String(t).toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);

/**
 * Build the EDL from loaded cues.
 * @param cues [{start,end,text}] from transcript.load()
 * @param opts {floor} minimum gap (seconds) that counts as dead air (default 0.45)
 */
function analyze(cues, { floor = 0.45 } = {}) {
  if (!cues || !cues.length) return { error: 'no cues found - is this an srt, vtt or whisper json?' };
  const dur = cues[cues.length - 1].end;
  const cuts = [];
  for (let i = 0; i < cues.length; i++) {
    const { start: s, end: e, text: t } = cues[i];
    if (FILLER_ONLY.test(t)) cuts.push({ kind: 'FILLER', start: s, end: e, why: t.trim().slice(0, 48) });
    if (i > 0) {
      const gap = s - cues[i - 1].end;
      if (gap > floor) {
        const keep = floor / 2;
        cuts.push({ kind: 'DEAD', start: +(cues[i - 1].end + keep).toFixed(3), end: +(s - keep).toFixed(3), why: `${gap.toFixed(2)}s gap` });
      }
    }
    // A restart is compared against the last cue that was actually SPEECH. Comparing against the
    // literal previous cue misses every retake with an "um" between the two attempts, which is most of them.
    if (t.trim() && !FILLER_ONLY.test(t)) {
      let j = i - 1;
      while (j >= 0 && (FILLER_ONLY.test(cues[j].text) || !cues[j].text.trim())) j--;
      if (j >= 0) {
        const a1 = norm(cues[j].text).slice(0, 5), b1 = norm(t).slice(0, 5);
        if (a1.length >= 3 && a1.join(' ') === b1.join(' ')) {
          cuts.push({ kind: 'REPEAT', start: cues[j].start, end: cues[j].end, why: `restart of "${a1.join(' ')}"` });
        }
      }
    }
  }
  const kept = cuts.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const removed = kept.reduce((sum, c) => sum + (c.end - c.start), 0);
  return { duration: +dur.toFixed(2), cues: cues.length, floor, cuts: kept, removed: +removed.toFixed(3), out: +(dur - removed).toFixed(3) };
}

/** convenience: load a transcript file and analyze it */
function analyzeFile(file, opts = {}) {
  return analyze(load(file), opts);
}

module.exports = { analyze, analyzeFile, FILLER_ONLY };
