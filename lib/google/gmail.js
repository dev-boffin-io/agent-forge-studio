'use strict';

// Gmail: search/list, read, send, labels and label changes through the Gmail API.
// The connected Google account must have granted gmail.modify + gmail.send (reconnect after upgrade).

const { authHeader, requestJson } = require('./api');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const MAX_LIST = 50;

function cleanHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function encodeWord(value) {
  const s = cleanHeader(value);
  return /[^\x20-\x7E]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s;
}

function headerMap(payload) {
  const out = {};
  for (const h of (payload && payload.headers) || []) {
    if (h && h.name) out[String(h.name).toLowerCase()] = h.value;
  }
  return out;
}

function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function collectBodies(payload, out = { text: [], html: [] }) {
  if (!payload) return out;
  const mime = String(payload.mimeType || '').toLowerCase();
  if (payload.body && payload.body.data) {
    const text = decodeBody(payload.body.data);
    if (mime === 'text/html') out.html.push(text);
    else out.text.push(text);
  }
  for (const part of payload.parts || []) collectBodies(part, out);
  return out;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageText(message) {
  const bodies = collectBodies(message && message.payload);
  if (bodies.text.length) return bodies.text.join('\n').trim();
  if (bodies.html.length) return stripHtml(bodies.html.join('\n'));
  if (message && message.snippet) return String(message.snippet);
  return '';
}

function summarize(message) {
  const h = headerMap(message && message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds || [],
    subject: h.subject || '',
    from: h.from || '',
    to: h.to || '',
    date: h.date || '',
    snippet: message.snippet || '',
  };
}

async function listMessages({ query = '', maxResults = 10, pageToken, labelIds, includeMetadata = true } = {}) {
  const headers = await authHeader();
  const limit = Math.max(1, Math.min(Number(maxResults) || 10, MAX_LIST));
  const u = new URL(`${GMAIL}/users/me/messages`);
  if (query) u.searchParams.set('q', String(query));
  u.searchParams.set('maxResults', String(limit));
  if (pageToken) u.searchParams.set('pageToken', String(pageToken));
  for (const label of (Array.isArray(labelIds) ? labelIds : [])) u.searchParams.append('labelIds', String(label));
  const data = await requestJson(u, { headers }, 'gmail list');
  const messages = Array.isArray(data && data.messages) ? data.messages : [];
  if (!includeMetadata) {
    return { messages, nextPageToken: (data && data.nextPageToken) || null, resultSizeEstimate: (data && data.resultSizeEstimate) || 0 };
  }
  const detailed = await Promise.all(messages.map(async (m) => {
    try {
      const full = await getMessage({ id: m.id, format: 'metadata' });
      return { ...summarize(full), snippet: full.snippet || '' };
    } catch {
      return { id: m.id, threadId: m.threadId, subject: '', from: '', to: '', date: '', snippet: '' };
    }
  }));
  return { messages: detailed, nextPageToken: (data && data.nextPageToken) || null, resultSizeEstimate: (data && data.resultSizeEstimate) || 0 };
}

async function getMessage({ id, format = 'full' } = {}) {
  if (!id) throw new Error('message id is required');
  const headers = await authHeader();
  const u = new URL(`${GMAIL}/users/me/messages/${encodeURIComponent(String(id))}`);
  u.searchParams.set('format', String(format || 'full'));
  if (format === 'metadata') u.searchParams.set('metadataHeaders', 'Subject,From,To,Date,Message-ID');
  return requestJson(u, { headers }, 'gmail read');
}

async function getThread({ id, format = 'full' } = {}) {
  if (!id) throw new Error('thread id is required');
  const headers = await authHeader();
  const u = new URL(`${GMAIL}/users/me/threads/${encodeURIComponent(String(id))}`);
  u.searchParams.set('format', String(format || 'full'));
  return requestJson(u, { headers }, 'gmail thread');
}

async function listLabels() {
  const headers = await authHeader();
  const data = await requestJson(`${GMAIL}/users/me/labels`, { headers }, 'gmail labels');
  return { labels: (data && data.labels) || [] };
}

function buildRaw({ to, subject = '', body = '', cc = '', bcc = '', html = false, inReplyTo, references }) {
  const lines = [
    'MIME-Version: 1.0',
    `To: ${cleanHeader(to)}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
  ];
  if (cc) lines.push(`Cc: ${cleanHeader(cc)}`);
  if (bcc) lines.push(`Bcc: ${cleanHeader(bcc)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${cleanHeader(inReplyTo)}`);
  if (references) lines.push(`References: ${cleanHeader(references)}`);
  lines.push(`Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
  lines.push('Content-Transfer-Encoding: base64');
  const encodedBody = Buffer.from(String(body), 'utf8').toString('base64');
  const raw = `${lines.join('\r\n')}\r\n\r\n${encodedBody}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

async function sendMessage({ to, subject, body, cc, bcc, html, threadId, inReplyTo, references } = {}) {
  if (!to || !String(to).trim()) throw new Error('to is required');
  const headers = await authHeader();
  const payload = { raw: buildRaw({ to, subject, body, cc, bcc, html, inReplyTo, references }) };
  if (threadId) payload.threadId = String(threadId);
  const data = await requestJson(`${GMAIL}/users/me/messages/send`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: payload,
  }, 'gmail send');
  return { ok: true, id: data && data.id, threadId: data && data.threadId, labelIds: (data && data.labelIds) || [] };
}

async function modifyMessage({ id, addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!id) throw new Error('message id is required');
  const headers = await authHeader();
  return requestJson(`${GMAIL}/users/me/messages/${encodeURIComponent(String(id))}/modify`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: {
      addLabelIds: (Array.isArray(addLabelIds) ? addLabelIds : []).map(String),
      removeLabelIds: (Array.isArray(removeLabelIds) ? removeLabelIds : []).map(String),
    },
  }, 'gmail modify');
}

async function trashMessage({ id } = {}) {
  if (!id) throw new Error('message id is required');
  const headers = await authHeader();
  return requestJson(`${GMAIL}/users/me/messages/${encodeURIComponent(String(id))}/trash`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: {},
  }, 'gmail trash');
}

module.exports = {
  GMAIL, listMessages, getMessage, getThread, listLabels,
  sendMessage, modifyMessage, trashMessage, messageText, summarize,
};
