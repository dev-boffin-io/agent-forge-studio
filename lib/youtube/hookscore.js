'use strict';

// hookscore — score a YouTube hook before you waste a take on it. Ported faithfully from
// skills/yt-script/hookscore.py + hooks.json (21 formulas).
//
// Five properties, 0-100 each, and a verdict that is 60% the mean and 40% the weakest one. The
// weakest-link weighting is deliberate: a hook with four strong properties and one dead one is a
// hook that leaks at the dead one, and averaging hides that.
//
// WHAT THIS CAN AND CANNOT TELL YOU. Measured against 74 real short-form hooks (first 15 seconds of
// auto-captions, top-8 and bottom-8 by views across five channels): it separates deliberately bad
// hooks from real ones well, and it separates a creator's own hits from their own misses barely at
// all. Treat a low score as a reason to look again, never a high score as a promise.

const { hooks: FORMULAS } = require('./hooks.json');

const FILLER = new Set(['basically', 'actually', 'literally', 'just', 'really', 'very', 'so', 'kind', 'sort', 'like',
  'guys', 'hey', 'welcome', 'today', 'video', 'subscribe', 'channel']);
const VAGUE = new Set(['amazing', 'incredible', 'insane', 'crazy', 'huge', 'massive', 'game', 'changer', 'secret',
  'powerful', 'ultimate', 'best', 'revolutionary', 'mind', 'blowing', 'unbelievable']);
const CONCRETE = /\b(\d[\d,.]*\s?(%|k|m|x|s|m|h)?|\$\d|\d+\s?(second|minute|hour|day|week|month|year)s?)\b/i;
const YOU = /\b(you|your|you're|youre|yourself)\b/i;
const STAKE = /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead)\b/i;
const CURIOSITY = /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b/i;
const SELF_CLOSED = /\b(because|so that|which means)\b/i;

const words = (t) => String(t).toLowerCase().match(/[a-z0-9'%$.]+/g) || [];
const count = (t, re) => (String(t).match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
const clamp = (v) => Math.max(0, Math.min(100, v));

function specificity(t) {
  const w = words(t);
  if (!w.length) return 0;
  const nums = count(t, CONCRETE);
  const vague = w.filter((x) => VAGUE.has(x)).length;
  const filler = w.filter((x) => FILLER.has(x)).length;
  let s = 34 + nums * 22 - vague * 16 - filler * 5;
  // proper nouns that are not sentence-initial read as named things
  s += Math.min(18, 6 * String(t).trim().split(/\s+/).slice(1).filter((x) => x && x[0] === x[0].toUpperCase() && x[0] !== x[0].toLowerCase()).length);
  return clamp(s);
}

function address(t) {
  const n = count(t, YOU);
  const first = YOU.test(String(t).trim().split(/\s+/).slice(0, 6).join(' ')) ? 30 : 0;
  return clamp(26 + n * 20 + first);
}

function stakes(t) {
  const n = count(t, STAKE);
  return clamp(22 + n * 26 + (CONCRETE.test(t) ? 14 : 0));
}

function curiosity(t) {
  const n = count(t, CURIOSITY);
  const q = String(t).trim().endsWith('?') ? 18 : 0;
  // a hook that resolves itself has no gap left
  const closed = SELF_CLOSED.test(t) ? -18 : 0;
  return clamp(24 + n * 17 + q + closed);
}

function brevity(t) {
  const n = words(t).length;
  if (n === 0) return 0;
  // 9-24 words is the band a spoken hook lands in at ~150wpm inside 10 seconds
  if (n >= 9 && n <= 24) return 100;
  if (n < 9) return Math.max(30, 100 - (9 - n) * 11);
  return Math.max(10, 100 - (n - 24) * 7);
}

const PROPS = [['SPECIFICITY', specificity], ['ADDRESS', address], ['STAKES', stakes], ['CURIOSITY', curiosity], ['BREVITY', brevity]];

function classify(t) {
  let best = null, hits = 0;
  for (const f of FORMULAS) {
    let n = 0;
    for (const p of f.match) if (new RegExp(p, 'i').test(t)) n++;
    if (n > hits) { best = f; hits = n; }
  }
  return { name: best ? best.name : 'Unclassified', hits };
}

const band = (v) => (v >= 72 ? 'STRONG' : v >= 55 ? 'WORKABLE' : 'WEAK');

const FIX = {
  SPECIFICITY: 'swap one adjective for a number, a name or a date',
  ADDRESS: "say 'you' in the first six words",
  STAKES: 'name what it costs them to keep doing it the current way',
  CURIOSITY: 'cut the half of the sentence that answers itself',
  BREVITY: '9 to 24 words. Read it out loud and stop where you run out of breath',
};

/** score one hook text */
function scoreHook(t) {
  const properties = {};
  for (const [name, fn] of PROPS) properties[name] = fn(t);
  const vals = Object.values(properties);
  const verdict = Math.round(0.6 * (vals.reduce((a, b) => a + b, 0) / vals.length) + 0.4 * Math.min(...vals));
  const { name, hits } = classify(t);
  const weakest = PROPS.reduce((a, b) => (properties[a[0]] <= properties[b[0]] ? a : b))[0];
  return { hook: String(t).trim(), properties, verdict, band: band(verdict), formula: name, matched: hits, weakest, fix: FIX[weakest] };
}

/** score several hooks, ranked (best first) */
function scoreHooks(lines) {
  return lines.map((l) => String(l).trim()).filter(Boolean).map(scoreHook).sort((a, b) => b.verdict - a.verdict);
}

module.exports = { scoreHook, scoreHooks, band, FIX };
