'use strict';

// Google Docs: read, create, append/replace text via the Docs API.

const { authHeader, requestJson } = require('./api');

const DOCS = 'https://docs.googleapis.com/v1';

function documentText(doc) {
  const parts = [];
  const walk = (elements) => {
    for (const el of elements || []) {
      if (el.paragraph && Array.isArray(el.paragraph.elements)) {
        for (const pe of el.paragraph.elements) {
          if (pe.textRun && pe.textRun.content) parts.push(pe.textRun.content);
        }
      }
      if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      }
    }
  };
  walk(doc && doc.body && doc.body.content);
  return parts.join('');
}

async function getDocument({ documentId } = {}) {
  if (!documentId) throw new Error('documentId is required');
  const headers = await authHeader();
  return requestJson(`${DOCS}/documents/${encodeURIComponent(String(documentId))}`, { headers }, 'docs read');
}

async function getDocumentText({ documentId } = {}) {
  const doc = await getDocument({ documentId });
  return { documentId, title: (doc && doc.title) || '', text: documentText(doc) };
}

async function createDocument({ title } = {}) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  const headers = await authHeader();
  return requestJson(`${DOCS}/documents`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { title: String(title) },
  }, 'docs create');
}

async function batchUpdate({ documentId, requests } = {}) {
  if (!documentId) throw new Error('documentId is required');
  if (!Array.isArray(requests) || !requests.length) throw new Error('requests must be a non-empty array');
  const headers = await authHeader();
  return requestJson(`${DOCS}/documents/${encodeURIComponent(String(documentId))}:batchUpdate`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: { requests },
  }, 'docs update');
}

function endIndex(doc) {
  const content = (doc && doc.body && doc.body.content) || [];
  const last = content[content.length - 1];
  const index = last && Number(last.endIndex);
  return Number.isFinite(index) && index > 1 ? index - 1 : 1;
}

async function appendText({ documentId, text } = {}) {
  if (text === undefined || text === null || String(text) === '') throw new Error('text is required');
  const doc = await getDocument({ documentId });
  const index = endIndex(doc);
  await batchUpdate({
    documentId,
    requests: [{ insertText: { location: { index }, text: String(text) } }],
  });
  return { ok: true, documentId, insertedAt: index, characters: String(text).length };
}

async function replaceText({ documentId, find, replace = '', matchCase = true } = {}) {
  if (!find) throw new Error('find is required');
  const result = await batchUpdate({
    documentId,
    requests: [{
      replaceAllText: {
        containsText: { text: String(find), matchCase: !!matchCase },
        replaceText: String(replace),
      },
    }],
  });
  const reply = (result && result.replies && result.replies[0]) || {};
  return { ok: true, documentId, occurrencesChanged: (reply.replaceAllText && reply.replaceAllText.occurrencesChanged) || 0 };
}

module.exports = {
  DOCS, getDocument, getDocumentText, createDocument, batchUpdate, appendText, replaceText, documentText,
};
