'use strict';

// llm — provider-agnostic chat interface. A "provider" is:
//   { id, type: 'ollama'|'openai'|'anthropic', endpoint, apiKey?, contextWindow? }
// The default provider (id 'default') uses top-level config.endpoint / config.apiKey and type
// 'ollama'. sendChat streams via callbacks and normalizes every provider into the same shape.

const log = require('./log');
const { explain, isRetryable } = require('./errors');
const { fetchOk } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveProvider(cfg, id) {
  if (!id || id === 'default') {
    return {
      id: 'default',
      type: 'ollama',
      endpoint: String(cfg.endpoint || 'http://localhost:11434').replace(/\/+$/, ''),
      apiKey: cfg.apiKey || '',
      contextWindow: 0,
    };
  }
  const p = (cfg.providers || {})[id];
  if (!p) throw new Error(`unknown provider: ${id}`);
  const apiKey = p.apiKeyEnv ? (process.env[p.apiKeyEnv] || '') : (p.apiKey || '');
  return {
    id,
    type: p.type || 'ollama',
    endpoint: String(p.endpoint || cfg.endpoint || '').replace(/\/+$/, ''),
    apiKey,
    contextWindow: Number(p.contextWindow) || 0,
  };
}

/**
 * Resolve a model reference like "groq/llama-3.3-70b" or "default/qwen3:8b" into a provider +
 * bare model name. Heads that match a configured provider id are treated as providers; anything
 * else (including ollama names that contain "/") stays part of the model name.
 */
function resolveModel(cfg) {
  const ref = String(cfg.model || '').trim();
  let providerId = cfg.defaultProvider || 'default';
  let model = ref;
  const idx = ref.indexOf('/');
  if (idx > 0) {
    const head = ref.slice(0, idx);
    if (head === 'default' || (cfg.providers && cfg.providers[head])) {
      providerId = head;
      model = ref.slice(idx + 1);
    }
  }
  return { provider: resolveProvider(cfg, providerId), model };
}

const PROVIDER_MODULES = {
  ollama: () => require('./ollama'),
  openai: () => require('./openai'),
  anthropic: () => require('./anthropic'),
};

const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes — a hung request can never block a run forever

/**
 * Combine the caller's abort signal with a timeout signal so a provider request is always bounded.
 * Returns { signal, cleanup, timedOut() } — timedOut() tells if the timeout (not the caller) fired.
 */
function withTimeout(signal, timeoutMs) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : controller.signal;
  return {
    signal: combined,
    cleanup: () => clearTimeout(timer),
    timedOut: () => timedOut,
    timeoutMs: ms,
  };
}

/**
 * Stream a chat completion.
 * @param provider resolved provider
 * @param opts {model, messages, temperature, numCtx, thinking, signal, timeoutMs,
 *              onToken(t), onThinking(t), onToolCall(tc), signal}
 * @returns {text, thinking, toolCalls, model}
 */
async function sendChat(provider, opts) {
  const mod = PROVIDER_MODULES[provider.type]();
  const maxRetries = 3;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(opts.signal, opts.timeoutMs);
    try {
      return await mod.sendChat(provider, { ...opts, signal: t.signal });
    } catch (err) {
      lastErr = err;
      // a caller abort passes straight through unchanged — the caller asked to stop
      if (opts.signal && opts.signal.aborted) throw err;
      // a timeout must stop immediately — never retry into another hang
      if (t.timedOut()) {
        const e = new Error(`request timed out after ${Math.round(t.timeoutMs / 1000)}s (${provider.type}${provider.endpoint ? ' @ ' + provider.endpoint : ''})`);
        e.name = 'TimeoutError';
        e.code = 'ETIMEDOUT';
        throw e;
      }
      if (attempt === maxRetries || !isRetryable(err)) break;
      const wait = 500 * Math.pow(2, attempt);
      log.warn('llm', `${provider.type} attempt ${attempt + 1} failed, retrying in ${wait}ms`, err);
      await sleep(wait);
    } finally {
      t.cleanup();
    }
  }
  const e = new Error(explain(lastErr, provider.endpoint || provider.type));
  e.cause = lastErr;
  throw e;
}

/** List models (best effort; returns [] on failure). */
async function listModels(provider) {
  try {
    const mod = PROVIDER_MODULES[provider.type]();
    if (typeof mod.listModels === 'function') return await mod.listModels(provider);
  } catch (err) {
    log.debug('llm', 'listModels failed', err);
  }
  return [];
}

module.exports = { resolveProvider, resolveModel, sendChat, listModels, withTimeout, DEFAULT_TIMEOUT_MS };
