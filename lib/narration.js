'use strict';

// narration — turn a written video script into the text a voice should actually SPEAK.
// The script contains markdown, headings, [ON SCREEN: ...] / [B-ROLL: ...] cues, section labels
// ("HOOK:", "Beat 2 —") and timestamps. Reading those aloud (or truncating at a fixed length in
// the middle of a sentence) is what made the voiceover sound wrong.

const MAX_NARRATION_CHARS = 24000;

const LABEL = /^\s*(?:hook|intro|outro|cta|call to action|beat\s*\d+|scene\s*\d+|section\s*\d+|part\s*\d+|voice[\s-]?over|v\.?o\.?|narrator|narration|host|speaker)\b[^:：\n]{0,40}[:：]\s*/i;

function toNarration(script, { max = MAX_NARRATION_CHARS } = {}) {
  let t = String(script == null ? '' : script);
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // code fences
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');                      // html comments
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                 // images
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');           // [text](url) -> text
  t = t.replace(/\[[^\]]*\]/g, ' ');                           // [ON SCREEN: ...] and other cues
  t = t.replace(/\(\s*\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\s*\)/g, ' '); // (0:00–0:15)

  const lines = t.split(/\r?\n/).map((raw) => {
    let l = raw.trim();
    if (!l) return '';
    if (/^(?:[-*_]\s*){3,}$/.test(l)) return '';               // --- rules
    if (/^\(.*\)$/.test(l)) return '';                         // (stage direction)
    l = l.replace(/^#{1,6}\s*/, '').replace(/^>\s*/, '');      // headings, quotes
    l = l.replace(/^(?:[-*+•]|\d+[.)])\s+/, '');               // bullets / numbering
    l = l.replace(/[*_~`]{1,3}/g, '');                         // emphasis markers
    l = l.replace(LABEL, '');                                  // "HOOK:" etc.
    return l.trim();
  }).filter(Boolean);

  // headings and short label lines get a full stop so the voice pauses instead of running on
  const joined = lines.map((l) => (/[.!?।॥。！？؟…:]$/.test(l) ? l : `${l}.`)).join('\n');
  let out = joined.replace(/[ \t]+/g, ' ').trim();

  if (out.length > max) {
    const cut = out.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('। '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trim();
  }
  return out;
}

module.exports = { toNarration, MAX_NARRATION_CHARS };
