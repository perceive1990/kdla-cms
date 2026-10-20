'use strict';
const session = require('express-session');

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * express-session store backed by the "sessions" Cosmos container.
 * Each session document carries a "ttl" so Cosmos deletes it automatically when it expires,
 * which keeps people logged in across App Service restarts (the free tier restarts often).
 * Unchanged sessions are re-saved at most every 5 minutes to save request units.
 */
class DbSessionStore extends session.Store {
  constructor(db, { ttlSeconds }) {
    super();
    this.db = db;
    this.ttlSeconds = ttlSeconds;
    this.lastWrite = new Map();
  }

  _ttl(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      const s = Math.ceil((new Date(sess.cookie.expires).getTime() - Date.now()) / 1000);
      return Math.max(s, 60);
    }
    return this.ttlSeconds;
  }

  get(sid, cb) {
    this.db.get('sessions', sid)
      .then((doc) => {
        if (!doc) return cb(null, null);
        if (doc.expiresAt && doc.expiresAt < Date.now()) return cb(null, null);
        return cb(null, doc.data);
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    const ttl = this._ttl(sess);
    this.db.upsert('sessions', { id: sid, data: sess, ttl, expiresAt: Date.now() + ttl * 1000 })
      .then(() => {
        this.lastWrite.set(sid, Date.now());
        if (this.lastWrite.size > 5000) this.lastWrite.clear();
        if (cb) cb(null);
      })
      .catch((e) => cb && cb(e));
  }

  touch(sid, sess, cb) {
    const last = this.lastWrite.get(sid) || 0;
    if (Date.now() - last < TOUCH_INTERVAL_MS) return cb && cb(null);
    return this.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    this.lastWrite.delete(sid);
    this.db.remove('sessions', sid)
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
}

module.exports = DbSessionStore;
