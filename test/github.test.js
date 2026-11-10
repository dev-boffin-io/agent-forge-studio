'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup } = require('./helpers');
setup();

const gh = require('../lib/github');
const api = require('../lib/github/api');

const cfg = { github: { token: 'ghp_test', apiBase: 'https://api.github.com' } };

function jsonResponse(obj, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function withMockFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = orig; });
}

test('github: status reports token source without leaking the token', () => {
  const s = gh.status(cfg);
  assert.equal(s.hasToken, true);
  assert.equal(s.tokenSource, 'config');
  assert.equal(s.apiBase, 'https://api.github.com');
  assert.ok(!JSON.stringify(s).includes('ghp_test'));
});

test('github: listRepos uses Bearer auth and expected query', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return jsonResponse([{ full_name: 'me/repo' }]);
  }, async () => {
    const repos = await api.listRepos({ type: 'owner', perPage: 10, cfg });
    assert.equal(repos[0].full_name, 'me/repo');
  });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.github.com/user/repos');
  assert.equal(u.searchParams.get('per_page'), '10');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer ghp_test');
  assert.equal(calls[0].opts.headers['x-github-api-version'], '2022-11-28');
});

test('github: getFile decodes base64 content', async () => {
  await withMockFetch(async () => jsonResponse({
    type: 'file', path: 'a.txt', name: 'a.txt', sha: 'abc', size: 5,
    encoding: 'base64', content: Buffer.from('hello').toString('base64'),
    html_url: 'https://github.com/me/repo/blob/main/a.txt',
  }), async () => {
    const file = await api.getFile({ owner: 'me', repo: 'repo', path: 'a.txt', cfg });
    assert.equal(file.content, 'hello');
    assert.equal(file.sha, 'abc');
  });
});

test('github: writeFile looks up the existing sha and PUTs base64 content', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (!opts.method || opts.method === 'GET') return jsonResponse({ type: 'file', sha: 'old-sha', content: '' });
    return jsonResponse({ content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } });
  }, async () => {
    const r = await api.writeFile({ owner: 'me', repo: 'repo', path: 'dir/a.txt', content: 'updated', message: 'Update a', branch: 'main', cfg });
    assert.equal(r.ok, true);
    assert.equal(r.sha, 'new-sha');
    assert.equal(r.commit, 'commit-sha');
  });
  assert.equal(calls[0].opts.method, 'GET');
  const put = calls.find((c) => c.opts.method === 'PUT');
  const body = JSON.parse(put.opts.body);
  assert.equal(body.sha, 'old-sha');
  assert.equal(body.branch, 'main');
  assert.equal(Buffer.from(body.content, 'base64').toString(), 'updated');
});

test('github: createIssue sends title, body, labels', async () => {
  let sent;
  await withMockFetch(async (url, opts) => {
    sent = JSON.parse(opts.body);
    return jsonResponse({ number: 7, html_url: 'https://github.com/me/repo/issues/7' });
  }, async () => {
    const issue = await api.createIssue({ owner: 'me', repo: 'repo', title: 'Bug', body: 'Details', labels: ['bug'], cfg });
    assert.equal(issue.number, 7);
  });
  assert.equal(sent.title, 'Bug');
  assert.equal(sent.body, 'Details');
  assert.deepEqual(sent.labels, ['bug']);
});

test('github: config token can be saved and masked', () => {
  const cfgMod = require('../lib/config');
  const llm = require('../lib/llm');
  cfgMod.saveConfig({ github: { token: 'ghp_saved' } });
  const masked = llm.maskConfig(cfgMod.loadConfig());
  assert.ok(!masked.github.token);
  assert.match(masked.github.tokenMasked, /^••••/);
  assert.equal(gh.token(cfgMod.loadConfig()), 'ghp_saved');
  cfgMod.saveConfig({ github: { token: '' } });
});
