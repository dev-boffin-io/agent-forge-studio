'use strict';

// titlelint — lint a YouTube title and thumbnail pairing before you publish it. Ported faithfully
// from skills/yt-package/title.py.
//
// The pairing is the unit, not the title. A title that repeats the thumbnail text wastes half the
// click surface, and that is the single most common mistake this checks for.
//
// Length: YouTube truncates around 60 characters on desktop search and around 40 on a mobile home
// feed. Both limits are reported because they are different failures - a desktop truncation loses the
// tail, a mobile one can lose the subject.

const DESKTOP = 60, MOBILE = 40, HARD = 100;
const VAGUE = new Set(['amazing', 'incredible', 'insane', 'crazy', 'huge', 'massive', 'ultimate', 'best', 'powerful',
  'secret', 'revolutionary', 'mindblowing', 'epic', 'perfect', 'complete', 'everything']);
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'with', 'your', 'you', 'my', 'i',
  'this', 'that', 'it', 'how', 'what', 'why']);

const words = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];

/** lint a title (optionally against thumbnail text) */
function checkTitle(title, thumb = null) {
  const t = String(title).trim();
  const n = t.length;
  const issues = [], good = [];
  if (n > HARD) issues.push(['length', `${n} characters - YouTube's hard limit is ${HARD}`]);
  else if (n > DESKTOP) issues.push(['length', `${n} characters - desktop search cuts near ${DESKTOP}`]);
  else good.push(`${n} characters, inside the ${DESKTOP}-character desktop cut`);
  if (n > MOBILE) {
    const head = t.slice(0, MOBILE).replace(/\s+\S*$/, '');
    issues.push(['mobile', `a mobile feed shows about "${head}..." - check the subject survives`]);
  }
  const caps = t.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && w !== w.toLowerCase());
  if (caps.length > 2) issues.push(['shouting', `${caps.length} all-caps words - two is the ceiling before it reads as spam`]);
  else if (caps.length) good.push(`${caps.length} all-caps word for emphasis`);
  const v = words(t).filter((w) => VAGUE.has(w));
  if (v.length) issues.push(['vague', `${[...new Set(v)].sort().join(', ')} - swap for a number, a name or a date`]);
  const nums = t.match(/\d[\d,.]*%?/g) || [];
  if (nums.length) good.push(`carries a concrete figure (${nums.slice(0, 3).join(', ')})`);
  else issues.push(['no-number', 'no number, date or name - the most reliable single fix']);
  if (t.endsWith('?')) good.push('open question in the title');
  const front = words(t).slice(0, 3).filter((w) => !STOP.has(w));
  if (!front.length) issues.push(['front-load', 'the first three words are all filler - move the subject forward']);
  if (thumb) {
    const tw = new Set(words(t).filter((w) => !STOP.has(w)));
    const hw = words(thumb).filter((w) => !STOP.has(w));
    const shared = hw.filter((w) => tw.has(w));
    if (shared.length) {
      issues.push(['duplicate', `thumbnail repeats the title on ${[...new Set(shared)].sort().join(', ')} - the thumbnail should say what the title does not`]);
    } else good.push('thumbnail and title carry different words');
    const hwCount = words(thumb).length;
    if (hwCount > 4) issues.push(['thumb-length', `${hwCount} words on the thumbnail - three is the ceiling at feed size`]);
  }
  const score = Math.max(0, Math.min(100, 100 - 14 * issues.length + 4 * good.length));
  return { title: t, chars: n, score, issues, good };
}

/** lint several titles, ranked (best first) */
function checkTitles(list, thumb = null) {
  return list.map((l) => String(l).trim()).filter(Boolean).map((t) => checkTitle(t, thumb)).sort((a, b) => b.score - a.score);
}

module.exports = { checkTitle, checkTitles, DESKTOP, MOBILE, HARD };
