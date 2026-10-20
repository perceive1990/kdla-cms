'use strict';
// API tokens. The token itself is shown once; only its SHA-256 hash is stored, so a copy of the
// database cannot be used to call the API. Tokens end when they expire, when they are revoked,
// when the account is disabled, and whenever the person's sessions are ended (password change,
// two-step change, "sign out other devices", or an administrator reset).
const crypto = require('crypto');
const config = require('../config');
const { newId, now, str } = require('../helpers');

const PREFIX = 'kdla_';
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** kind: "session" (from the API login) or "personal" (created under Account > API access). */
async function issueToken(db, user, {
  kind = 'session', label = '', hours, days, ip = '',
} = {}) {
  const raw = PREFIX + crypto.randomBytes(32).toString('base64url');
  const seconds = Math.round(kind === 'personal' ? days * 86400 : (hours || config.api.tokenHours) * 3600);
  const doc = {
    id: hashToken(raw),
    ref: newId(), // public identifier for listing and revoking (the hash is never shown)
    userId: user.id,
    kind,
    label: str(label, 80) || (kind === 'personal' ? 'Personal token' : 'API sign-in'),
    hint: raw.slice(-4),
    epoch: user.sessionEpoch || 0,
    createdAt: now(),
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    lastUsedAt: null,
    createdIp: ip,
    ttl: seconds, // Cosmos DB deletes the record when it expires
  };
  await db.create('apiTokens', doc);
  return { token: raw, doc };
}

const secondsLeft = (doc) => Math.max(60, Math.ceil((Date.parse(doc.expiresAt) - Date.now()) / 1000));

/** Look up a presented token. Returns { doc, user } or null. */
async function verifyToken(db, raw) {
  const t = String(raw || '');
  if (!t.startsWith(PREFIX) || t.length > 120) return null;
  const doc = await db.get('apiTokens', hashToken(t));
  if (!doc) return null;
  const expired = !(Date.parse(doc.expiresAt) > Date.now());
  const user = expired ? null : await db.get('users', doc.userId);
  if (!user || user.active === false || (user.sessionEpoch || 0) !== doc.epoch) {
    db.remove('apiTokens', doc.id).catch(() => {});
    return null;
  }
  return { doc, user };
}

/** Record when a token was last used (at most every few minutes, to save database writes). */
function touch(db, doc) {
  if (doc.lastUsedAt && Date.now() - Date.parse(doc.lastUsedAt) < TOUCH_EVERY_MS) return;
  // Cosmos DB counts "ttl" from the last write, so it is set again to the time remaining.
  // If-Match makes sure this never undoes a change made meanwhile (such as rebind after a password change).
  db.replace('apiTokens', { ...doc, lastUsedAt: now(), ttl: secondsLeft(doc) }, { ifMatch: doc._etag }).catch(() => {});
}

/** Keep a token working after its owner's sessions were ended on purpose (for example a password change). */
async function rebind(db, doc, epoch) {
  await db.replace('apiTokens', { ...doc, epoch, ttl: secondsLeft(doc) });
}

/** A token as shown in lists: never the token or its hash. */
function publicToken(doc, currentId) {
  return {
    id: doc.ref,
    kind: doc.kind,
    label: doc.label,
    hint: doc.hint,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    lastUsedAt: doc.lastUsedAt,
    current: doc.id === currentId,
  };
}

/** The user's tokens that still work, newest first. */
async function listTokens(db, user) {
  const rows = await db.find('apiTokens', { where: { userId: user.id }, orderBy: ['createdAt', 'DESC'] });
  return rows.filter((d) => Date.parse(d.expiresAt) > Date.now() && d.epoch === (user.sessionEpoch || 0));
}

/** Revoke one of the user's tokens by its public id. Returns the revoked record or null. */
async function revokeToken(db, user, ref) {
  const [doc] = await db.find('apiTokens', { where: { userId: user.id, ref: str(ref, 60) }, limit: 1 });
  if (!doc) return null;
  await db.remove('apiTokens', doc.id);
  return doc;
}

module.exports = {
  PREFIX, hashToken, issueToken, verifyToken, touch, rebind, publicToken, listTokens, revokeToken,
};
