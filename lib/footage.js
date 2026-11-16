'use strict';

// footage — verify and prepare downloaded clips, and align shot timing to the voiceover.
//
// Verification is deliberately separate from searching: a file that downloaded successfully can
// still be corrupt, the wrong orientation, too short, or carry original production audio. This
// module probes every clip, can strip the original audio track (the renderer also mutes it), and
// writes a report the agent can inspect before rendering.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveOrientation } = require('./stock');

function absUnder(workDir, relPath) {
  const base = workDir || process.cwd();
  return path.isAbsolute(relPath) ? relPath : path.join(base, relPath);
}

function run(bin, args, timeout = 120000) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}

function hasTool(bin) {
  const r = run(bin, ['-version'], 5000);
  return !r.error && r.status === 0;
}

function sha256(file) {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
  } catch { return null; }
}

/** Probe one media file. Returns {ok, duration, width, height, videoCodec, audioCodecs, ...}. */
function probe(file) {
  const r = run('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json', String(file),
  ], 30000);
  if (r.error) return { ok: false, error: `${r.error.code === 'ENOENT' ? 'ffprobe is not installed' : r.error.message}` };
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'ffprobe failed').trim().split('\n').slice(-2).join(' | ') };
  let data;
  try { data = JSON.parse(r.stdout || '{}'); } catch { return { ok: false, error: 'ffprobe returned invalid JSON' }; }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (!video || !video.width) return { ok: false, error: 'no playable video stream' };
  const duration = Number((data.format || {}).duration) || 0;
  const bytes = Number((data.format || {}).size) || (fs.statSync(file, { throwIfNoEntry: false }) || {}).size || 0;
  return {
    ok: true,
    duration: Number(duration.toFixed(3)),
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    videoCodec: video.codec_name || '',
    audioCodecs: audio.map((s) => s.codec_name || 'unknown'),
    hasAudio: audio.length > 0,
    format: (data.format || {}).format_name || '',
    bytes,
  };
}

function orientationOf(width, height) {
  if (!width || !height) return '';
  if (width === height) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

function verifyClip(shot, { workDir, cfg = {}, limits = {} } = {}) {
  const file = shot && shot.file ? absUnder(workDir, shot.file) : '';
  if (!file) return { ...shot, verified: false, verifyError: 'no file path' };
  if (!fs.existsSync(file)) return { ...shot, verified: false, verifyError: 'file does not exist' };
  const info = probe(file);
  if (!info.ok) return { ...shot, verified: false, verifyError: info.error || 'unreadable video' };
  const wantOrientation = resolveOrientation(cfg);
  const actualOrientation = orientationOf(info.width, info.height);
  const minSeconds = Number(limits.minSeconds || (cfg.stockFootage && cfg.stockFootage.minClipSeconds) || 0) || 0;
  const maxSeconds = Number(limits.maxSeconds || (cfg.stockFootage && cfg.stockFootage.maxClipSeconds) || 0) || 0;
  const maxBytes = Number(limits.maxBytes || 0) || 0;
  const problems = [];
  if (wantOrientation !== 'square' && actualOrientation && actualOrientation !== wantOrientation) {
    problems.push(`orientation is ${actualOrientation}, wanted ${wantOrientation}`);
  }
  if (minSeconds && info.duration < minSeconds) problems.push(`shorter than ${minSeconds}s`);
  if (maxSeconds && info.duration > maxSeconds) problems.push(`longer than ${maxSeconds}s`);
  if (maxBytes && info.bytes > maxBytes) problems.push('larger than the size cap');
  return {
    ...shot,
    file: path.relative(workDir || process.cwd(), file),
    verified: problems.length === 0,
    verifyError: problems.join('; ') || null,
    duration: info.duration,
    width: info.width,
    height: info.height,
    orientation: actualOrientation,
    videoCodec: info.videoCodec,
    audioCodecs: info.audioCodecs,
    originalAudioPresent: !!info.hasAudio,
    bytes: info.bytes,
    sha256: sha256(file),
  };
}

/**
 * Remove the clip's production audio without re-encoding when the container allows it. The
 * renderer additionally uses -an on every segment, so original audio can never leak through.
 */
function stripOriginalAudio(file, { outPath } = {}) {
  if (!hasTool('ffmpeg')) return { ok: false, error: 'ffmpeg is not installed' };
  const src = String(file);
  const dest = outPath || path.join(path.dirname(src), 'prepared', `${path.basename(src, path.extname(src))}-muted.mp4`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let r = run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', dest]);
  if (r.status !== 0) {
    r = run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', dest]);
  }
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'ffmpeg failed').trim().split('\n').slice(-3).join(' | ') };
  const info = probe(dest);
  if (!info.ok) return { ok: false, error: info.error || 'muted output is unreadable' };
  return { ok: true, file: dest, duration: info.duration, width: info.width, height: info.height, bytes: info.bytes, audioCodecs: [] };
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(^|\s)[-–—*+>]\s+/g, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, ' ')
    .replace(/[#*_>`]/g, ' ')
    .split(/(?<=[.!?।॥。！？؟…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * Split narration into `count` contiguous scene weights. Longer scenes get proportionally more
 * voiceover time, so the b-roll follows the script instead of every cut getting equal time.
 */
function sceneWeights(script, count) {
  const n = Math.max(1, Number(count) || 1);
  const sentences = splitSentences(script);
  if (!sentences.length) return Array.from({ length: n }, () => 1);
  const buckets = Array.from({ length: n }, () => []);
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  const target = totalChars / n;
  let bucket = 0;
  let acc = 0;
  for (const sentence of sentences) {
    const midpoint = acc + sentence.length / 2;
    while (bucket < n - 1 && midpoint >= target * (bucket + 1)) bucket++;
    buckets[bucket].push(sentence);
    acc += sentence.length;
  }
  // Very long sentences can starve a later bucket; borrow the nearest sentence so every scene
  // still gets screen time instead of being an empty weight.
  for (let i = 0; i < n; i++) {
    if (!buckets[i].length) {
      const donor = i > 0 ? i - 1 : i + 1;
      if (buckets[donor] && buckets[donor].length > 1) buckets[i].push(buckets[donor].pop());
      else if (buckets[donor] && buckets[donor].length) buckets[i].push(buckets[donor][0]);
    }
  }
  return buckets.map((b) => Math.max(1, b.join(' ').length));
}

/** Give every shot a start/end on the voiceover timeline, proportional to its script scene. */
function alignShots(shots, totalSeconds, script = '') {
  const list = Array.isArray(shots) ? shots : [];
  const total = Number(totalSeconds) || 0;
  if (!list.length || total <= 0) return list;
  const weights = list.map((s, i) => {
    const explicit = Number(s && (s.weight || s.seconds));
    if (explicit > 0) return explicit;
    return null;
  });
  const finalWeights = weights.every((w) => w > 0) ? weights : sceneWeights(script, list.length);
  const sum = finalWeights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return list.map((s, i) => {
    const length = (finalWeights[i] / sum) * total;
    const start = cursor;
    cursor += length;
    const end = i === list.length - 1 ? total : cursor;
    return { ...s, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), sceneSeconds: Number((end - start).toFixed(2)) };
  });
}

/**
 * Verify every shot and optionally replace it with a muted copy. Never throws for a single bad
 * clip: the report says which ones failed so the caller can search/import again.
 */
function prepareFootage({ shots, workDir, cfg = {}, stripAudio = true, alignTo = 0, script = '', limits = {} } = {}) {
  const report = [];
  const prepared = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    if (!shot || !shot.file) { prepared.push(shot); continue; }
    let checked = verifyClip(shot, { workDir, cfg, limits });
    let muted = false;
    if (stripAudio && checked.verified && checked.originalAudioPresent) {
      const abs = absUnder(workDir, checked.file);
      const stripped = stripOriginalAudio(abs);
      if (stripped.ok) {
        checked = {
          ...checked,
          file: path.relative(workDir || process.cwd(), stripped.file),
          originalAudioPresent: false,
          audioMuted: true,
        };
        muted = true;
      } else {
        checked = { ...checked, audioMuted: false, stripError: stripped.error };
      }
    }
    if (!checked.originalAudioPresent) muted = true;
    prepared.push({ ...checked, audioMuted: muted });
    report.push({
      file: checked.file, verified: !!checked.verified, error: checked.verifyError || checked.stripError || null,
      duration: checked.duration || 0, width: checked.width || 0, height: checked.height || 0,
      orientation: checked.orientation || null, originalAudioPresent: !!checked.originalAudioPresent, audioMuted: !!muted,
      bytes: checked.bytes || 0,
    });
  }
  const aligned = alignTo > 0 ? alignShots(prepared, alignTo, script) : prepared;
  return {
    shots: aligned,
    report,
    verified: report.every((r) => r.verified),
    allAudioMuted: report.every((r) => r.audioMuted),
    stub: false,
  };
}

module.exports = {
  probe, verifyClip, stripOriginalAudio, prepareFootage, alignShots, sceneWeights, hasTool,
  splitSentences, orientationOf,
};
