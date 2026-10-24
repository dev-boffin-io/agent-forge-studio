'use strict';

// OAuth CSRF state — a signed, random, expiring, single-use nonce. The signature uses a
// per-process HMAC secret, so a state is only accepted by the process that issued it.
// Restarting the server invalidates in-flight consent screens.

const crypto = require('node:crypto');

const NONCE_BYTES = 32;
const TTL_MS = 10 * 60 * 1000;
const SECRET = crypto.randomBytes(32);
const issued = new Map(); // nonce -> expiresAt

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function prune(now) {
  for (const [nonce, expiresAt] of issued) {
    if (expiresAt <= now) issued.delete(nonce);
  }
}

/** Mint a fresh signed state: "<issuedAt>.<nonce>.<sig>". */
function createState(now = Date.now()) {
  prune(now);
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const payload = `${now}.${nonce}`;
  issued.set(nonce, now + TTL_MS);
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a state echoed back by the provider. Valid only once, within its TTL, and only when
 * the HMAC matches. Malformed, missing, expired, replayed or mismatched values return false.
 */
function verifyState(state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtRaw, nonce, sig] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || !nonce || !sig) return false;
  if (Math.abs(now - issuedAt) > TTL_MS) return false;

  prune(now);
  const expiresAt = issued.get(nonce);
  if (!expiresAt || expiresAt <= now) return false;

  const expected = sign(`${issuedAtRaw}.${nonce}`);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  issued.delete(nonce); // single use — a replayed callback must fail
  return true;
}

module.exports = { createState, verifyState, TTL_MS };
