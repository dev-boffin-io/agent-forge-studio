'use strict';

// Agent — the autonomous loop. Streams a model conversation, executes its tool calls for real,
// feeds results back, and keeps going until the model stops calling tools (or maxIterations).
// Emits SSE events so the UI can follow along live. Also runs subagents (scout/reviewer) in
// isolated inner loops and returns their final report to the parent.

const log = require('./log');
const llm = require('./llm');
const sessions = require('./sessions');
const agents = require('./agents');
const tools = require('./tools');
const voice = require('./youtube/voice');
const { getWorkDir } = require('./config');
const { isRetryable, explain } = require('./errors');

const COMPACT_CHARS = 160000;   // ~ above this many chars of history, compact the middle
const KEEP_RECENT = 12;         // messages kept verbatim during compaction

function nowMetrics(startedAt, extra = {}) {
  return { elapsedMs: Date.now() - startedAt, ...extra };
}

/** Build the per-run context handed to tool executors. */
function makeCtx({ cfg, emit, onQuestion, runSubagent, onTodos }) {
  return { cfg, onQuestion, runSubagent, onTodos };
}

/**
 * Run one agent turn-loop over a session until the model produces a final (no-tool) answer.
 *
 * @param opts.session   loaded session object (persisted as it goes)
 * @param opts.cfg       resolved config
 * @param opts.emit      (event, payload) => {}  — SSE sink
 * @param opts.signal    AbortSignal
 * @param opts.gate      async (category, subject, label) => {ok, reason?}
 * @param opts.onQuestion async (question, options) => answer
 * @param opts.onSubagent optional (agentId, prompt) => report — wired to runSubagent
 * @param opts.onTodos   optional (todos) => void
 * @param opts.agentId   override the session's agent
 */
async function runLoop(opts) {
  const {
    session, cfg, emit, signal,
    gate, onQuestion, onSubagent, onTodos,
    agentId,
  } = opts;

  const agent = agents.getAgent(agentId || session.agent || cfg.agent || 'create');
  const provider = llm.resolveProvider(cfg, cfg.providerId || cfg.defaultProvider || 'default');
  const model = cfg.model;
  if (!model) throw new Error('no model selected — open Providers and pick one');

  const voiceText = agent.voice ? voice.read(getWorkDir()) : '';
  const system = agents.systemPromptFor(agent, cfg, voiceText);
  // hide tools whose category is wholly denied for this agent (e.g. browser for analyze/scout)
  const effectivePerm = { ...(cfg.permission || {}), ...(agent.permission || {}) };
  const toolSchemas = tools.schemasFor(tools.TOOLS.filter((t) => effectivePerm[t.category] !== 'deny').map((t) => t.name));

  const startedAt = Date.now();
  let iterations = 0;
  const maxIter = Number(cfg.maxIterations) || 100;

  const ctx = makeCtx({
    cfg,
    emit,
    onQuestion: async (q, o) => {
      // the server emits the interactive "question" SSE event itself (with the pending-answer id)
      const a = onQuestion ? await onQuestion(q, o) : '';
      return a;
    },
    runSubagent: async (subId, prompt) => {
      emit('subagent', { agent: subId, status: 'start' });
      try {
        const report = await runSubagent(subId, prompt, { cfg, emit, signal, gate });
        emit('subagent', { agent: subId, status: 'done' });
        return { report };
      } catch (e) {
        emit('subagent', { agent: subId, status: 'error', error: e.message });
        throw e;
      }
    },
    onTodos: (todos) => emit('todos', { todos }),
  });

  emit('start', { agent: agent.id, model, sessionId: session.id });

  let lastToolSig = '', lastToolCount = 0;
  let finalText = '';

  while (iterations < maxIter) {
    if (signal && signal.aborted) { emit('aborted', {}); return { text: finalText, iterations, aborted: true }; }
    iterations++;
    emit('iteration', { n: iterations });

    // compaction
    const history = sessions.pruneForModel(session);
    const totalChars = history.reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
    if (cfg.autoCompact !== false && totalChars > COMPACT_CHARS && history.length > KEEP_RECENT + 4) {
      emit('compacting', {});
      try {
        const kept = history.slice(0, 2).concat(history.slice(-KEEP_RECENT));
        const middle = history.slice(2, -KEEP_RECENT).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 2000) : ''}`).join('\n').slice(0, 120000);
        const sumModel = cfg.smallModel || model;
        const sumRes = await llm.sendChat(provider, {
          model: sumModel,
          messages: [
            { role: 'system', content: 'Summarize this conversation for an agent that will continue the work. Keep every concrete decision, file path, number and unresolved question. Plain text, under 1500 words.' },
            { role: 'user', content: middle },
          ],
          temperature: 0.2,
          signal,
        });
        const summaryMsg = { role: 'user', content: `[conversation summary so far]\n${sumRes.text}` };
        session.summary = sumRes.text.slice(0, 4000);
        session.messages = [summaryMsg].concat(history.slice(-KEEP_RECENT).map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId })));
        sessions.saveSession(session);
        log.info('agent', `compacted session ${session.id} (was ${totalChars} chars)`);
      } catch (e) {
        log.warn('agent', 'compaction failed; continuing with full history', e);
        emit('warning', { message: 'compaction failed: ' + e.message });
      }
    }

    // provider call
    const messages = [{ role: 'system', content: system }].concat(sessions.pruneForModel(session));
    let res;
    try {
      res = await llm.sendChat(provider, {
        model,
        messages,
        system,                       // used by openai/anthropic modules; ollama uses the inline message
        temperature: cfg.temperature != null ? cfg.temperature : 0.6,
        numCtx: Number(cfg.numCtx) || 0,
        thinking: !!cfg.thinking,
        tools: toolSchemas,
        signal,
        onToken: (t) => emit('token', { text: t }),
        onThinking: (t) => emit('thinking', { text: t }),
      });
    } catch (e) {
      if ((signal && signal.aborted) || e.name === 'AbortError') { emit('aborted', {}); return { text: finalText, iterations, aborted: true }; }
      emit('error', { message: explain(e, provider.endpoint) });
      if (isRetryable(e) && iterations < maxIter) {
        emit('retry', { attempt: 1, reason: explain(e, provider.endpoint) });
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw e;
    }

    const text = res.text || '';
    const toolCalls = res.toolCalls || [];

    // persist the assistant turn
    sessions.append(session, {
      role: 'assistant',
      content: text,
      thinking: res.thinking || '',
      toolCalls,
    });

    if (!toolCalls.length) {
      finalText = text;
      emit('done', { text, iterations, metrics: nowMetrics(startedAt, { iterations }) });
      emit('metrics', nowMetrics(startedAt, { iterations }));
      // auto-title once
      if (session.title === 'New session' || !session.title) {
        try {
          const tr = await llm.sendChat(provider, {
            model: cfg.smallModel || model,
            messages: [
              { role: 'system', content: 'Generate a short session title (max 6 words) for this conversation. Reply with the title only.' },
              { role: 'user', content: (session.messages.find((m) => m.role === 'user') || { content: '' }).content.slice(0, 1500) },
            ],
            temperature: 0.3,
            signal,
          });
          const t = (tr.text || '').split('\n')[0].replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80);
          if (t) {
            sessions.setTitle(session.id, t);
            session.title = t;
            emit('title', { title: t });
          }
        } catch (e) { log.debug('agent', 'auto-title failed', e); }
      }
      return { text, iterations, metrics: nowMetrics(startedAt, { iterations }) };
    }

    // execute each tool call in order, feeding results back as tool messages
    for (const tc of toolCalls) {
      const name = tc.function && tc.function.name;
      const rawArgs = (tc.function && tc.function.arguments) || '{}';
      emit('tool_call', { id: tc.id, name, args: rawArgs });

      // doom-loop guard: identical consecutive call 3x → stop with a warning
      const sig = name + '|' + rawArgs;
      if (sig === lastToolSig) { lastToolCount++; } else { lastToolSig = sig; lastToolCount = 1; }
      if (lastToolCount >= 3) {
        const msg = `error: the same tool call (${name}) repeated ${lastToolCount} times with no progress. Change approach or ask the human.`;
        sessions.append(session, { role: 'tool', toolCallId: tc.id, content: msg });
        emit('tool_result', { id: tc.id, name, content: msg, error: true });
        emit('warning', { message: 'doom loop detected — same call 3x' });
        continue;
      }

      const tool = tools.byName.get(name);
      const category = tool ? tool.category : 'read';

      // permission gate — when it needs to ask, the server emits the permission_request SSE itself
      let gateRes = { ok: true };
      if (gate && category !== 'read' && category !== 'skill' && category !== 'task' && category !== 'doom_loop') {
        gateRes = await gate(category, summarizeSubject(name, rawArgs), name);
        if (!gateRes.ok) {
          const msg = `error: permission denied for ${name} (${gateRes.reason || 'denied'})`;
          sessions.append(session, { role: 'tool', toolCallId: tc.id, content: msg });
          emit('tool_result', { id: tc.id, name, content: msg, error: true });
          continue;
        }
      }

      const out = await tools.executeTool(name, rawArgs, ctx);
      sessions.append(session, { role: 'tool', toolCallId: tc.id, content: out.content, name });
      emit('tool_result', { id: tc.id, name, content: out.content, error: !!out.error });
    }
  }

  emit('warning', { message: `hit maxIterations (${maxIter}) — stopping loop` });
  emit('done', { text: finalText, iterations, metrics: nowMetrics(startedAt, { iterations }) });
  return { text: finalText, iterations, metrics: nowMetrics(startedAt, { iterations }) };
}

function summarizeSubject(name, rawArgs) {
  try {
    const a = JSON.parse(rawArgs);
    if (name === 'bash') return a.command || '';
    if (a.path) return a.path;
    if (a.url) return a.url;
    if (a.query) return a.query;
    return rawArgs.slice(0, 120);
  } catch { return String(rawArgs || '').slice(0, 120); }
}

/**
 * Run a subagent in an isolated throwaway conversation.
 * @returns final assistant text
 */
async function runSubagent(agentId, prompt, { cfg, emit, signal, gate }) {
  const agent = agents.getAgent(agentId);
  if (!agent) throw new Error(`unknown subagent: ${agentId}`);
  // subagents get their own ephemeral session record for the duration of the run
  const sub = sessions.createSession({ title: `subagent:${agentId}`, agent: agentId });
  try {
    sessions.append(sub, { role: 'user', content: prompt });
    const res = await runLoop({
      session: sub, cfg, emit, signal, gate,
      agentId,
      onQuestion: async () => '',
      onSubagent: async () => { throw new Error('subagents cannot nest'); },
      onTodos: () => {},
    });
    return res.text;
  } finally {
    sessions.deleteSession(sub.id);
  }
}

module.exports = { runLoop, runSubagent, summarizeSubject };
