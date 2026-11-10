'use strict';

// GitHub REST API client. Authenticates with the token from config (or GITHUB_TOKEN / GH_TOKEN).

const { fetchOk } = require('../errors');
const gh = require('./index');

function headers(cfg, extra) {
  const h = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-forge-studio/1.0',
    ...(extra || {}),
  };
  const token = gh.token(cfg);
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function apiUrl(path, query, cfg) {
  const base = gh.apiBase(cfg);
  const u = new URL(`${base}/${String(path).replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return u;
}

async function request(path, { method = 'GET', body, query, cfg } = {}) {
  const u = apiUrl(path, query, cfg);
  const opts = { method, headers: headers(cfg) };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetchOk(u, opts, { source: 'GitHub API', where: u.host });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function repoPath(owner, repo) {
  if (!owner || !repo) throw new Error('owner and repo are required');
  return `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}`;
}

function contentPath(owner, repo, filePath) {
  if (!filePath) throw new Error('path is required');
  return `${repoPath(owner, repo)}/contents/${String(filePath).split('/').map(encodeURIComponent).join('/')}`;
}

async function getUser({ cfg } = {}) {
  return request('/user', { cfg });
}

async function listRepos({ type = 'owner', sort = 'updated', perPage = 30, page, cfg } = {}) {
  return request('/user/repos', { query: { type, sort, per_page: perPage, page }, cfg });
}

async function getRepo({ owner, repo, cfg } = {}) {
  return request(repoPath(owner, repo), { cfg });
}

async function listIssues({ owner, repo, state = 'open', labels, sort = 'updated', direction = 'desc', perPage = 30, page, includePullRequests = false, cfg } = {}) {
  const items = await request(`${repoPath(owner, repo)}/issues`, {
    query: { state, labels, sort, direction, per_page: perPage, page }, cfg,
  });
  return includePullRequests ? items : (Array.isArray(items) ? items.filter((i) => !i.pull_request) : items);
}

async function getIssue({ owner, repo, number, cfg } = {}) {
  if (!number) throw new Error('issue number is required');
  return request(`${repoPath(owner, repo)}/issues/${encodeURIComponent(String(number))}`, { cfg });
}

async function createIssue({ owner, repo, title, body = '', labels, assignees, cfg } = {}) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  return request(`${repoPath(owner, repo)}/issues`, {
    method: 'POST',
    body: { title: String(title), body: String(body || ''), labels, assignees },
    cfg,
  });
}

async function updateIssue({ owner, repo, number, title, body, state, labels, assignees, cfg } = {}) {
  if (!number) throw new Error('issue number is required');
  const patch = {};
  if (title !== undefined) patch.title = String(title);
  if (body !== undefined) patch.body = String(body);
  if (state !== undefined) patch.state = String(state);
  if (labels !== undefined) patch.labels = labels;
  if (assignees !== undefined) patch.assignees = assignees;
  return request(`${repoPath(owner, repo)}/issues/${encodeURIComponent(String(number))}`, { method: 'PATCH', body: patch, cfg });
}

async function commentIssue({ owner, repo, number, body, cfg } = {}) {
  if (!number) throw new Error('issue number is required');
  if (!body || !String(body).trim()) throw new Error('body is required');
  return request(`${repoPath(owner, repo)}/issues/${encodeURIComponent(String(number))}/comments`, {
    method: 'POST',
    body: { body: String(body) },
    cfg,
  });
}

async function listPullRequests({ owner, repo, state = 'open', head, base, sort = 'updated', direction = 'desc', perPage = 30, page, cfg } = {}) {
  return request(`${repoPath(owner, repo)}/pulls`, {
    query: { state, head, base, sort, direction, per_page: perPage, page }, cfg,
  });
}

async function getPullRequest({ owner, repo, number, cfg } = {}) {
  if (!number) throw new Error('pull request number is required');
  return request(`${repoPath(owner, repo)}/pulls/${encodeURIComponent(String(number))}`, { cfg });
}

async function createPullRequest({ owner, repo, title, head, base, body = '', draft = false, cfg } = {}) {
  if (!title || !head || !base) throw new Error('title, head and base are required');
  return request(`${repoPath(owner, repo)}/pulls`, {
    method: 'POST',
    body: { title: String(title), head: String(head), base: String(base), body: String(body || ''), draft: !!draft },
    cfg,
  });
}

async function listCommits({ owner, repo, sha, path, perPage = 30, page, cfg } = {}) {
  return request(`${repoPath(owner, repo)}/commits`, {
    query: { sha, path, per_page: perPage, page }, cfg,
  });
}

async function listBranches({ owner, repo, perPage = 30, page, cfg } = {}) {
  return request(`${repoPath(owner, repo)}/branches`, { query: { per_page: perPage, page }, cfg });
}

async function listReleases({ owner, repo, perPage = 30, page, cfg } = {}) {
  return request(`${repoPath(owner, repo)}/releases`, { query: { per_page: perPage, page }, cfg });
}

async function createRelease({ owner, repo, tagName, name, body = '', targetCommitish, draft = false, prerelease = false, cfg } = {}) {
  if (!tagName) throw new Error('tagName is required');
  return request(`${repoPath(owner, repo)}/releases`, {
    method: 'POST',
    body: {
      tag_name: String(tagName),
      name: name === undefined ? String(tagName) : String(name),
      body: String(body || ''),
      target_commitish: targetCommitish,
      draft: !!draft,
      prerelease: !!prerelease,
    },
    cfg,
  });
}

async function getFile({ owner, repo, path: filePath, ref, cfg } = {}) {
  const data = await request(contentPath(owner, repo, filePath), { query: { ref }, cfg });
  if (!data || data.type !== 'file') return data;
  let text = null;
  if (data.encoding === 'base64' && data.content) {
    text = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  }
  return {
    path: data.path,
    name: data.name,
    sha: data.sha,
    size: data.size,
    type: data.type,
    html_url: data.html_url,
    download_url: data.download_url,
    encoding: data.encoding,
    content: text,
  };
}

async function writeFile({ owner, repo, path: filePath, content, message, branch, sha, cfg } = {}) {
  if (content === undefined || content === null) throw new Error('content is required');
  let existingSha = sha;
  if (!existingSha) {
    try {
      const existing = await getFile({ owner, repo, path: filePath, ref: branch, cfg });
      if (existing && existing.sha) existingSha = existing.sha;
    } catch { /* new file */ }
  }
  const body = {
    message: String(message || `Update ${filePath}`),
    content: Buffer.from(String(content), 'utf8').toString('base64'),
    ...(branch ? { branch: String(branch) } : {}),
    ...(existingSha ? { sha: String(existingSha) } : {}),
  };
  const data = await request(contentPath(owner, repo, filePath), { method: 'PUT', body, cfg });
  return { ok: true, path: filePath, sha: data && data.content && data.content.sha, commit: data && data.commit && data.commit.sha };
}

async function deleteFile({ owner, repo, path: filePath, message, branch, sha, cfg } = {}) {
  let existingSha = sha;
  if (!existingSha) {
    const existing = await getFile({ owner, repo, path: filePath, ref: branch, cfg });
    if (!existing || !existing.sha) throw new Error(`file not found: ${filePath}`);
    existingSha = existing.sha;
  }
  const data = await request(contentPath(owner, repo, filePath), {
    method: 'DELETE',
    body: {
      message: String(message || `Delete ${filePath}`),
      sha: String(existingSha),
      ...(branch ? { branch: String(branch) } : {}),
    },
    cfg,
  });
  return { ok: true, path: filePath, commit: data && data.commit && data.commit.sha };
}

async function searchRepos({ query, perPage = 20, page, cfg } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  return request('/search/repositories', { query: { q: String(query), per_page: perPage, page }, cfg });
}

module.exports = {
  request, headers, apiUrl, repoPath, contentPath,
  getUser, listRepos, getRepo, searchRepos,
  listIssues, getIssue, createIssue, updateIssue, commentIssue,
  listPullRequests, getPullRequest, createPullRequest,
  listCommits, listBranches, listReleases, createRelease,
  getFile, writeFile, deleteFile,
};
