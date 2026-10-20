'use strict';
// Password and two-step checks used by both the web login page and the API login,
// so lockout, recovery codes and audit logging work the same way for both.
const { verifyPassword, lockMinutesLeft, failedLoginUpdate } = require('../auth');
const totp = require('../totp');
const { audit } = require('../audit');

async function patchUser(db, id, patch) {
  const fresh = await db.get('users', id);
  if (fresh) await db.replace('users', { ...fresh, ...patch });
}

/**
 * Check a username and password, applying the lockout rules.
 * Returns { ok: true, user, username } or { ok: false, status, code, message, username }.
 */
async function checkPassword(req, rawUsername, rawPassword) {
  const username = String(rawUsername || '').trim().toLowerCase().slice(0, 60);
  const password = String(rawPassword || '').slice(0, 200);
  const [user] = username ? await req.db.find('users', { where: { username }, limit: 1 }) : [];

  const locked = lockMinutesLeft(user);
  if (locked) {
    await verifyPassword(password, null); // keep timing similar
    audit(req, 'login_failed', 'users', user.id, 'Login attempt while account locked', { user });
    return {
      ok: false, status: 423, code: 'account_locked', username,
      message: `This account is locked after too many wrong passwords. Try again in ${locked} minute${locked === 1 ? '' : 's'}, or ask an administrator.`,
    };
  }

  const result = user && user.active !== false ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, null);
  if (!result.ok) {
    if (user) {
      await patchUser(req.db, user.id, failedLoginUpdate(user));
      audit(req, 'login_failed', 'users', user.id, 'Wrong password', { user });
    } else {
      audit(req, 'login_failed', 'users', null, `Unknown username "${username}"`, { username });
    }
    return {
      ok: false, status: 401, code: 'invalid_credentials', username, message: 'Wrong username or password. Please try again.',
    };
  }
  return { ok: true, user, username };
}

/**
 * Check a 6-digit code from the authenticator app, or a one-time recovery code.
 * Returns { ok, patch }; save the patch on success so the same code cannot be used again.
 */
function checkCode(req, user, rawCode) {
  const code = String(rawCode || '').trim();
  const step = totp.verify(user.totpSecret, code, { lastStep: user.totpLastStep || -1 });
  if (step !== null) return { ok: true, patch: { totpLastStep: step } };
  if (/^[a-z2-7]{4}-?[a-z2-7]{4}$/i.test(code)) {
    const hash = totp.hashRecoveryCode(code.replace('-', '').replace(/^(.{4})/, '$1-'));
    const remaining = (user.recoveryCodes || []).filter((h) => h !== hash);
    if (remaining.length < (user.recoveryCodes || []).length) {
      audit(req, 'security', 'users', user.id, `Recovery code used (${remaining.length} left)`, { user });
      return { ok: true, patch: { recoveryCodes: remaining } };
    }
  }
  return { ok: false, patch: {} };
}

/** Count a wrong two-step code as a failed login (this is what locks the account after repeated guesses). */
async function recordFailedCode(req, user, summary) {
  await patchUser(req.db, user.id, failedLoginUpdate(user));
  audit(req, 'login_failed', 'users', user.id, summary, { user });
}

module.exports = {
  patchUser, checkPassword, checkCode, recordFailedCode,
};
