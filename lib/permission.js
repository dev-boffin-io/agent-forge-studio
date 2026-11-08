'use strict';

// Permission rules: a flat list of {permission, pattern, action}; the LAST matching rule wins.
// Config forms:  "edit": "deny"   or   "bash": { "git *": "allow", "rm *": "deny", "*": "ask" }
//
// Two call styles are supported:
//   decide('bash', 'ls -la', ctx)                    -> 'allow' | 'ask' | 'deny'   (agent loop)
//   decide(permissionMap, 'publish', 'yt_upload')    -> { decision, rule }         (platform gate)

const BASE_RULES = [
  { permission: '*', pattern: '*', action: 'allow' },
  { permission: 'doom_loop', pattern: '*', action: 'ask' },
  { permission: 'mcp', pattern: '*', action: 'ask' },            // MCP tools run third-party code
  { permission: 'webfetch_private', pattern: '*', action: 'ask' }, // localhost / LAN URLs (SSRF guard)
  { permission: 'read', pattern: '*', action: 'allow' },
  { permission: 'read', pattern: '*.env', action: 'ask' },
  { permission: 'read', pattern: '*.env.*', action: 'ask' },
  { permission: 'read', pattern: '*.env.example', action: 'allow' },
  { permission: 'browser_read', pattern: '*', action: 'allow' },
  { permission: 'browser_write', pattern: '*', action: 'ask' },
  { permission: 'publish', pattern: '*', action: 'ask' },
  { permission: 'outside_workspace', pattern: '*', action: 'ask' },
];

const CATEGORIES = ['edit', 'bash', 'read', 'webfetch', 'websearch', 'skill', 'task', 'doom_loop', 'publish', 'browser', 'browser_read', 'browser_write', 'outside_workspace', 'mcp', 'lsp', 'recall'];

// Categories that touch the public internet under the user's identity. We refuse to ever treat
// these as implicitly allowed: even if a config leaves them unset (or a future default sneaks an
// "allow" in), they resolve to "ask" so the human is always shown the publish gate before anything
// becomes public on YouTube.
const CONSENT_REQUIRED = new Set(['publish', 'yt_upload', 'yt_set_visibility']);

function fromConfig(obj) {
  const rules = [];
  for (const [permission, value] of Object.entries(obj || {})) {
    if (typeof value === 'string') rules.push({ permission, pattern: '*', action: value });
    else if (value && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value)) rules.push({ permission, pattern, action });
    }
  }
  return rules.filter((r) => ['allow', 'ask', 'deny'].includes(r.action));
}

function wildcard(str, pattern) {
  if (pattern === '*') return true;
  let re = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?'; // "ls *" also matches bare "ls"
  return new RegExp('^' + re + '$', 's').test(str);
}

const matchPattern = (rule, value) => wildcard(value, rule);

function evaluate(permission, pattern, ...rulesets) {
  const all = rulesets.flat();
  for (let i = all.length - 1; i >= 0; i--) {
    if (wildcard(permission, all[i].permission) && wildcard(pattern, all[i].pattern)) return all[i];
  }
  return { permission, pattern: '*', action: 'ask' };
}

const normalizeGrants = (session) => {
  if (!Array.isArray(session.grants)) {
    if (session.grants && typeof session.grants === 'object') {
      session.grants = Object.keys(session.grants).filter((k) => session.grants[k]).map((permission) => ({ permission, pattern: '*', action: 'allow' }));
    } else session.grants = [];
  }
  return session.grants;
};

/** defaults < config < agent. Session grants are layered on top but can never override a deny. */
function rulesFor(agent, config, inherited = []) {
  return [...BASE_RULES, ...fromConfig(config && config.permission), ...fromConfig(agent && agent.permission), ...inherited];
}

/** String API used by the agent loop and tools. */
function decide(permission, pattern, { agent, config, session, inherited } = {}) {
  if (permission && typeof permission === 'object') return decideMap(permission, pattern, arguments[2], arguments[3]);
  const rules = rulesFor(agent, config, inherited);
  const base = evaluate(permission, pattern, rules).action;
  if (base === 'deny') return 'deny';
  if (CONSENT_REQUIRED.has(permission) && base === 'allow') return 'ask';
  const grants = normalizeGrants(session || {});
  const granted = evaluate(permission, pattern, grants).action === 'allow' && grants.some((g) => wildcard(permission, g.permission) && wildcard(pattern, g.pattern));
  return granted ? 'allow' : base;
}

/** Object API used by platform/security gates. Never auto-allows a publish. */
function decideMap(permission, category, subject, ctx) {
  let perm = permission || {};
  if (ctx && ctx.agent && ctx.agent.permission) perm = { ...perm, ...(ctx.agent.permission || {}) };
  const categoryRules = perm[category];
  if (categoryRules != null) {
    if (typeof categoryRules === 'string') {
      if (CONSENT_REQUIRED.has(category) && categoryRules === 'allow') return { decision: 'ask', rule: '(publish requires consent)' };
      return { decision: categoryRules };
    }
    if (categoryRules && typeof categoryRules === 'object') {
      let chosen = null; let chosenRule = null;
      for (const [rule, dec] of Object.entries(categoryRules)) {
        if (matchPattern(rule, subject || '')) { chosen = dec; chosenRule = rule; }
      }
      if (chosen == null && categoryRules['*'] != null) { chosen = categoryRules['*']; chosenRule = '*'; }
      if (chosen == null) return { decision: 'ask' };
      if (CONSENT_REQUIRED.has(category) && chosen === 'allow') return { decision: 'ask', rule: '(publish requires consent)' };
      return { decision: chosen, rule: chosenRule };
    }
    return { decision: 'ask' };
  }
  if (category === 'browser_read' || category === 'browser_write') {
    const alias = perm.browser;
    if (alias != null) {
      if (typeof alias === 'string') {
        if (CONSENT_REQUIRED.has('browser') && alias === 'allow') return { decision: 'ask', rule: '(publish requires consent)' };
        return { decision: alias };
      }
      if (alias && typeof alias === 'object') {
        let chosen = null; let chosenRule = null;
        for (const [rule, dec] of Object.entries(alias)) {
          if (matchPattern(rule, subject || '')) { chosen = dec; chosenRule = rule; }
        }
        if (chosen == null && alias['*'] != null) { chosen = alias['*']; chosenRule = '*'; }
        if (chosen == null) return { decision: 'ask' };
        if (CONSENT_REQUIRED.has('browser') && chosen === 'allow') return { decision: 'ask', rule: '(publish requires consent)' };
        return { decision: chosen, rule: chosenRule };
      }
      return { decision: 'ask' };
    }
    return { decision: category === 'browser_read' ? 'allow' : 'ask' };
  }
  if (category === 'read' || category === 'skill' || category === 'task' || category === 'doom_loop') return { decision: 'allow' };
  if (category === 'publish') return { decision: 'ask', rule: 'publish requires consent' };
  return { decision: 'ask' };
}

/** True if the agent can never use this permission category (tool is hidden from the model). */
function disabled(permission, agent, config, inherited = []) {
  const rules = rulesFor(agent, config, inherited).filter((r) => wildcard(permission, r.permission));
  const last = rules[rules.length - 1];
  return !!last && last.pattern === '*' && last.action === 'deny';
}

/* ---------- bash: evaluate every segment of a compound command ---------- */

const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const COMPLEX = /[<>`]|\$\(|\$\{|<\(/; // redirects / substitutions: never auto-allowed

function bashSegments(command) {
  return String(command).split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function decideBash(command, ctx) {
  const segs = bashSegments(command);
  if (!segs.length) return 'deny';
  const complex = COMPLEX.test(command);
  let result = 'allow';
  for (const seg of [command, ...segs]) {
    const d = decide('bash', seg, ctx);
    if (d === 'deny') return 'deny';
    if (seg !== command && d === 'ask') result = 'ask';
  }
  // whole-string rule can also say ask/deny (e.g. "* | sh")
  if (decide('bash', command, ctx) === 'ask' && segs.length === 1) result = 'ask';
  if (complex && result === 'allow' && !normalizeGrants(ctx.session).some((g) => g.exact === command)) return 'ask';
  return result;
}

const TWO_TOKEN = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'cargo', 'go', 'pip', 'pip3', 'make', 'systemctl', 'apt', 'kubectl']);
const NEVER_BROAD = new Set(['rm', 'sudo', 'su', 'dd', 'mkfs', 'chmod', 'chown', 'kill', 'killall', 'mv', 'shutdown', 'reboot', 'curl', 'wget', 'sh', 'bash', 'eval']);

/** Remember an "always allow" for the shape of this command (not blanket bash). */
function grant(session, category, pattern) {
  const grants = normalizeGrants(session);
  const add = (p, extra = {}) => { if (!grants.some((g) => g.permission === category && g.pattern === p)) grants.push({ permission: category, pattern: p, action: 'allow', ...extra }); };
  if (category === 'webfetch') { try { return add(new URL(pattern).origin + '/*'); } catch { return add(pattern); } }
  if (category !== 'bash') return add(category === 'edit' ? '*' : pattern);
  if (COMPLEX.test(pattern)) return add(pattern, { exact: pattern });
  for (const seg of bashSegments(pattern)) {
    const toks = seg.split(/\s+/);
    if (NEVER_BROAD.has(toks[0])) add(seg);
    else add(TWO_TOKEN.has(toks[0]) && toks[1] ? `${toks[0]} ${toks[1]} *` : `${toks[0]} *`);
  }
}

function makeGate(permission, onAsk) {
  return async function gate(category, subject, label, opts = {}) {
    let { decision, rule } = decideMap(permission, category, subject);
    if (opts && opts.forceAsk && decision === 'allow') {
      decision = 'ask';
      rule = opts.reason || '(untrusted skill)';
    }
    if (decision === 'allow') return { ok: true };
    if (decision === 'deny') return { ok: false, reason: `denied by policy${rule ? ` (rule ${rule})` : ''}` };
    if (typeof onAsk !== 'function') return { ok: false, reason: 'permission required but no interactive handler' };
    const ans = await onAsk({ category, subject, label, reason: opts.reason || rule || null });
    if (ans === true || ans === 'allow') return { ok: true };
    if (ans === 'once') return { ok: true, once: true };
    return { ok: false, reason: 'denied by user' };
  };
}

module.exports = {
  CATEGORIES, BASE_RULES, fromConfig, wildcard, matchPattern, evaluate, normalizeGrants, rulesFor,
  decide, decideMap, disabled, bashSegments, decideBash, grant, makeGate,
};
