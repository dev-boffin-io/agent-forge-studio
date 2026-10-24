'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const sessions = require('../lib/sessions');

test('create / load / list / delete', () => {
  const s = sessions.createSession({ agent: 'create', title: 'First' });
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(s.messages, []);
  assert.equal(s.archived, false);

  const got = sessions.loadSession(s.id);
  assert.equal(got.title, 'First');
  assert.equal(got.agent, 'create');

  const rows = sessions.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, s.id);
  assert.equal(rows[0].messages, 0);

  assert.equal(sessions.deleteSession(s.id), true);
  assert.throws(() => sessions.loadSession(s.id), /ENOENT/);
});

test('load rejects invalid ids and keeps summaries out of list rows', () => {
  assert.throws(() => sessions.loadSession('../../evil'));
  assert.throws(() => sessions.loadSession('nope'));
  const s = sessions.createSession({ title: 'Summarised' });
  s.summary = 'A summary';
  sessions.saveSession(s);
  const row = sessions.listSessions().find((r) => r.id === s.id);
  assert.equal(row.summary, 'A summary');
  assert.equal(row.title, 'Summarised');
});

test('saveSession persists messages and bumps updatedAt', async () => {
  const s = sessions.createSession({ title: 'Chat' });
  const before = s.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  s.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  sessions.saveSession(s);
  const got = sessions.loadSession(s.id);
  assert.equal(got.messages.length, 2);
  assert.ok(got.updatedAt > before);
});

test('append / updateLastAssistant / editMessage maintain the transcript', () => {
  const s = sessions.createSession({ title: 'Messages' });
  sessions.append(s.id, { role: 'user', content: 'question' });
  sessions.append(s.id, { role: 'assistant', content: 'partial', thinking: 'thinking...' });
  sessions.updateLastAssistant(s.id, 'complete');
  let got = sessions.loadSession(s.id);
  assert.equal(got.messages[1].content, 'complete');
  assert.equal(got.messages[1].thinking, 'thinking...');

  sessions.editMessage(s.id, 0, 'new question');
  got = sessions.loadSession(s.id);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].content, 'new question');
  assert.throws(() => sessions.editMessage(s.id, 99, 'x'), /bad message index/);
});

test('setTitle / setAgent / archiveSession update metadata', () => {
  const s = sessions.createSession({ title: 'Old', agent: 'create' });
  sessions.setTitle(s.id, 'New');
  sessions.setAgent(s.id, 'analyze');
  const got = sessions.loadSession(s.id);
  assert.equal(got.title, 'New');
  assert.equal(got.agent, 'analyze');

  sessions.archiveSession(s.id, true);
  assert.ok(!sessions.listSessions().some((r) => r.id === s.id));
  assert.ok(sessions.listSessions({ archived: true }).some((r) => r.id === s.id));
  sessions.archiveSession(s.id, false);
  assert.ok(sessions.listSessions().some((r) => r.id === s.id));
});

test('pruneForModel trims older tool output but keeps recent messages', () => {
  const s = sessions.createSession({ title: 'Prune' });
  const big = 'x'.repeat(4000);
  s.messages = [
    ...Array.from({ length: 32 }, (_, i) => ({ role: 'user', content: 'm' + i })),
    { role: 'tool', content: big },
  ];
  const out = sessions.pruneForModel(s, { keepRecent: 5 });
  assert.equal(out.length, 33);
  assert.ok(out[out.length - 1].content.length <= sessions.MAX_TOOL_CHARS);
});
