'use strict';
const bcrypt = require('bcryptjs');
const config = require('./config');

const BCRYPT_ROUNDS = 12;
// Compared against when the username does not exist, so response time does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

/** Checks a password against its bcrypt hash. Returns { ok }. */
async function verifyPassword(plain, stored) {
  if (!stored || !String(stored).startsWith('$2')) {
    await bcrypt.compare(String(plain), DUMMY_HASH); // keep timing the same for unknown users
    return { ok: false };
  }
  return { ok: await bcrypt.compare(String(plain), stored) };
}

function passwordProblem(pw, username) {
  const p = String(pw || '');
  if (p.length < 10) return 'Password must be at least 10 characters.';
  if (p.length > 200) return 'Password is too long.';
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  if (/^\d+$/.test(p)) return 'Password cannot be only numbers.';
  if (/^(.)\1+$/.test(p)) return 'Password cannot be one repeated character.';
  return null;
}

/** Minutes left on a lock, or 0 if the account is not locked. */
function lockMinutesLeft(user) {
  if (!user || !user.lockedUntil) return 0;
  const ms = new Date(user.lockedUntil).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** Record a failed login on the user and lock the account when the limit is reached. */
function failedLoginUpdate(user) {
  const failed = (user.failedLogins || 0) + 1;
  const update = { failedLogins: failed };
  if (config.loginMaxFailures > 0 && failed >= config.loginMaxFailures) {
    update.lockedUntil = new Date(Date.now() + config.lockMinutes * 60000).toISOString();
    update.failedLogins = 0;
  }
  return update;
}

function needs2faSetup(user) {
  if (!user || user.totpEnabled) return false;
  return config.require2fa === 'all' || (config.require2fa === 'admins' && user.role === 'admin');
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  // No flash message here: unauthenticated requests must not create session records.
  const target = req.method === 'GET' && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  return res.redirect(`/login${target}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403);
  return res.render('error', { title: 'Not allowed', message: 'Only administrators can do this.' });
}

module.exports = {
  hashPassword, verifyPassword, passwordProblem, requireLogin, requireAdmin, lockMinutesLeft, failedLoginUpdate, needs2faSetup,
};
