'use strict';

// llm timeout — a provider request must be bounded so a hung endpoint can never block a run.

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../lib/llm');

function fakeProvider(type = 'ollama') {
  return { id: 't', type, endpoint: 'http://127.0.0.1:1' };
}

test('llm: a hanging provider times out instead of blocking forever', async () => {
  const mod = require('../lib/ollama');
  const orig = mod.sendChat;
  // simulate a provider that never resolves, but honours the abort signal
  mod.sendChat = (provider, opts) => new Promise((_res, rej) => {
    if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => llm.sendChat(fakeProvider(), { model: 'm', messages: [], timeoutMs: 80 }),
      (e) => e.name === 'TimeoutError' && e.code === 'ETIMEDOUT' && /timed out after/i.test(e.message),
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `should abort quickly, took ${dt}ms`);
  } finally {
    mod.sendChat = orig;
  }
});

test('llm: a timeout is not retried (no extra delay / no repeated hanging)', async () => {
  const mod = require('../lib/ollama');
  const orig = mod.sendChat;
  let calls = 0;
  mod.sendChat = (provider, opts) => {
    calls++;
    return new Promise((_res, rej) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  try {
    await assert.rejects(() => llm.sendChat(fakeProvider(), { model: 'm', messages: [], timeoutMs: 60 }));
    assert.equal(calls, 1, 'the hanging call must not be retried');
  } finally {
    mod.sendChat = orig;
  }
});

test('llm: a caller abort passes through immediately', async () => {
  const mod = require('../lib/ollama');
  const orig = mod.sendChat;
  mod.sendChat = (provider, opts) => new Promise((_res, rej) => {
    if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    const ac = new AbortController();
    const p = llm.sendChat(fakeProvider(), { model: 'm', messages: [], timeoutMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(() => p, (e) => e.name === 'AbortError');
  } finally {
    mod.sendChat = orig;
  }
});

test('llm: a normal fast response is unaffected', async () => {
  const mod = require('../lib/ollama');
  const orig = mod.sendChat;
  mod.sendChat = async () => ({ text: 'hi', toolCalls: [] });
  try {
    const res = await llm.sendChat(fakeProvider(), { model: 'm', messages: [], timeoutMs: 5000 });
    assert.equal(res.text, 'hi');
  } finally {
    mod.sendChat = orig;
  }
});
