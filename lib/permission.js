'use strict';

// Permission — category-based allow/ask/deny for tool calls. Categories: edit, bash, read,
// webfetch, websearch, skill, task, doom_loop, publish, browser. Config shape (per category):
//   "allow" | "ask" | "deny"                       — blanket
//   { "*": "ask", "ls *": "allow", "rm *": "deny" } — bash/pattern map, last matching rule wins
// The UI never blocks; "ask" pauses the loop and asks the human via SSE permission_request.

const log = require('./log');

const CATEGORIES = ['edit', 'bash', 'read', 'webfetch', 'websearch', 'skill', 'task', 'doom_loop', 'publish', 'browser'];


function matchPattern(rule, value) {
  if (rule === '*') return true;
  // simple glob: * at start/end/inside, ? single char
  const rx = new RegExp('^' + String(rule).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return rx.test(value);
}

/**
 * Decide what to do for a call.
 * @returns {decision: 'allow'|'ask'|'deny', rule?: string}
 */
function decide(permission, category, subject) {
  const rules = (permission || {})[category];
  if (rules == null) {
    // defaults: reads always, browser automation is the human's visible window (allowed so the
    // agent can work while they watch), everything else asks unless configured
    if (category === 'read' || category === 'skill' || category === 'task' || category === 'doom_loop' || category === 'browser') return { decision: 'allow' };
    return { decision: 'ask' };
  }
  if (typeof rules === 'string') return { decision: rules };
  if (rules && typeof rules === 'object') {
    let chosen = null, chosenRule = null;
    for (const [rule, dec] of Object.entries(rules)) {
      if (matchPattern(rule, subject || '')) { chosen = dec; chosenRule = rule; }
    }
    if (chosen == null && rules['*'] != null) { chosen = rules['*']; chosenRule = '*'; }
    if (chosen == null) return { decision: 'ask' };
    return { decision: chosen, rule: chosenRule };
  }
  return { decision: 'ask' };
}

/** A resolver the agent loop uses: checks config; on 'ask' it awaits the human via onAsk. */
function makeGate(permission, onAsk) {
  return async function gate(category, subject, label) {
    const { decision, rule } = decide(permission, category, subject);
    if (decision === 'allow') return { ok: true };
    if (decision === 'deny') return { ok: false, reason: `denied by policy${rule ? ` (rule ${rule})` : ''}` };
    // ask
    if (typeof onAsk !== 'function') return { ok: false, reason: 'permission required but no interactive handler' };
    const ans = await onAsk({ category, subject, label });
    if (ans === true || ans === 'allow') return { ok: true };
    if (ans === 'once') return { ok: true, once: true };
    return { ok: false, reason: 'denied by user' };
  };
}

module.exports = { CATEGORIES, decide, makeGate, matchPattern };
