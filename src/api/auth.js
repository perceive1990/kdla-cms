'use strict';
// API sign-in with bearer tokens, and the signed-in user's own account.
const express = require('express');
const config = require('../config');
const { needs2faSetup, verifyPassword } = require('../auth');
const { audit, clientIp } = require('../audit');
const { isAdmin } = require('../access');
const { loginLimiter } = require('../limits');
const { now, str } = require('../helpers');
const signin = require('../services/signin');
const acct = require('../services/account');
const { publicUser } = require('../services/directory');
const { HttpError, forbidden } = require('../services/errors');
const tokens = require('./tokens');
const { failIfInvalid, invalid } = require('./http');

const TWO_STEP_SETUP = 'KDLA requires two-step verification for your account. Set it up in the web app under '
  + 'Account > Password and security, then sign in to the API again.';

// ---------- Middleware ----------

// Open to a signed-in user who still has to change a temporary password or set up two-step verification.
const OPEN_WHILE_BLOCKED = new Set(['GET /me', 'POST /auth/logout', 'POST /me/password']);

/** Accept "Authorization: Bearer <token>" and load the user. */
async function authenticate(req, res, next) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  if (!m) {
    res.set('WWW-Authenticate', 'Bearer realm="KDLA API"');
    throw new HttpError(401, 'unauthorized', 'Sign in first and send the token as "Authorization: Bearer <token>". '
      + 'Get a token from POST /api/v1/auth/login, or create one under Account > API access.');
  }
  const found = await tokens.verifyToken(req.db, m[1]);
  if (!found) {
    res.set('WWW-Authenticate', 'Bearer realm="KDLA API", error="invalid_token"');
    throw new HttpError(401, 'invalid_token', 'This token has expired or has been revoked. Sign in again.');
  }
  req.user = found.user;
  req.apiToken = found.doc;
  tokens.touch(req.db, found.doc);

  const open = OPEN_WHILE_BLOCKED.has(`${req.method} ${req.path}`);
  if (!open && req.user.mustChangePassword) {
    throw new HttpError(403, 'password_change_required', 'Choose a new password first with POST /api/v1/me/password.');
  }
  if (!open && needs2faSetup(req.user)) throw new HttpError(403, 'two_step_setup_required', TWO_STEP_SETUP);
  return next();
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) throw forbidden('Only administrators can do this.');
  next();
}

// ---------- Routes that work without a token ----------
const open = express.Router();

open.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password, code } = req.body;
  if (!str(username) || !password) throw invalid({ ...(!str(username) && { username: 'Enter your username.' }), ...(!password && { password: 'Enter your password.' }) });
  const check = await signin.checkPassword(req, username, password);
  if (!check.ok) throw new HttpError(check.status, check.code, check.message);
  const { user } = check;
  if (needs2faSetup(user)) throw new HttpError(403, 'two_step_setup_required', TWO_STEP_SETUP);

  const patch = { failedLogins: 0, lockedUntil: null, lastLoginAt: now() };
  if (user.totpEnabled) {
    // A correct password without a code does not reset the failure count, so guessing codes still locks the account.
    if (!str(code)) {
      throw new HttpError(401, 'two_step_required', 'This account uses two-step verification. Send the 6-digit code from your '
        + 'authenticator app, or one of your recovery codes, as "code".');
    }
    const result = signin.checkCode(req, user, code);
    if (!result.ok) {
      await signin.recordFailedCode(req, user, 'Wrong verification code (API sign-in)');
      throw new HttpError(401, 'invalid_code', 'That code is not correct. Check that the time on your phone is set automatically and try the newest code.');
    }
    Object.assign(patch, result.patch);
  }
  await signin.patchUser(req.db, user.id, patch);
  const { token, doc } = await tokens.issueToken(req.db, user, { kind: 'session', label: req.body.label || 'API sign-in', ip: clientIp(req) });
  audit(req, 'login', 'users', user.id, `Signed in to the API${user.totpEnabled ? ' with two-step verification' : ''}`, { user });
  res.status(201).json({
    token,
    tokenType: 'Bearer',
    expiresAt: doc.expiresAt,
    requiredActions: user.mustChangePassword ? ['change_password'] : [],
    user: publicUser(user, { full: true }),
  });
});

// ---------- Routes that need a token ----------
const secured = express.Router();

secured.post('/auth/logout', async (req, res) => {
  await req.db.remove('apiTokens', req.apiToken.id);
  audit(req, 'logout', 'users', req.user.id, 'Signed out of the API');
  res.status(204).end();
});

secured.get('/me', (req, res) => {
  const u = req.user;
  const requiredActions = [];
  if (u.mustChangePassword) requiredActions.push('change_password');
  if (needs2faSetup(u)) requiredActions.push('set_up_two_step');
  res.json({ user: publicUser(u, { full: true }), token: tokens.publicToken(req.apiToken, req.apiToken.id), requiredActions });
});

secured.post('/me/password', async (req, res) => {
  const { current, password } = req.body;
  const { errors, user } = await acct.changePassword(req, { current: str(current, 200), password: String(password || '') });
  failIfInvalid(errors);
  // Every other session and token has ended; keep this one working.
  await tokens.rebind(req.db, req.apiToken, user.sessionEpoch || 0);
  res.json({ ok: true, message: 'Password changed. Your other sessions and API tokens have been signed out.' });
});

secured.get('/me/tokens', async (req, res) => {
  const list = await tokens.listTokens(req.db, req.user);
  res.json({ data: list.map((d) => tokens.publicToken(d, req.apiToken.id)) });
});

/** Personal access token for scripts and reports. Asks for the password again before issuing a long-lived token. */
secured.post('/me/tokens', async (req, res) => {
  const days = parseInt(req.body.days, 10);
  const errors = {};
  if (!str(req.body.label)) errors.label = 'Give the token a name, for example "Power BI report".';
  if (!(days >= 1 && days <= config.api.personalTokenMaxDays)) errors.days = `Choose between 1 and ${config.api.personalTokenMaxDays} days.`;
  const check = await verifyPassword(String(req.body.password || ''), req.user.passwordHash);
  if (!check.ok) errors.password = 'Your password is not correct.';
  failIfInvalid(errors);
  const { token, doc } = await tokens.issueToken(req.db, req.user, {
    kind: 'personal', label: req.body.label, days, ip: clientIp(req),
  });
  audit(req, 'security', 'users', req.user.id, `Created personal API token "${doc.label}" (${days} days)`);
  res.status(201).json({ token, tokenType: 'Bearer', ...tokens.publicToken(doc) });
});

secured.delete('/me/tokens/:id', async (req, res) => {
  const doc = await tokens.revokeToken(req.db, req.user, req.params.id);
  if (!doc) throw new HttpError(404, 'not_found', 'Token not found.');
  audit(req, 'security', 'users', req.user.id, `Revoked API token "${doc.label}"`);
  res.status(204).end();
});

module.exports = {
  authenticate, adminOnly, open, secured,
};
