'use strict';
const express = require('express');
const { audit } = require('../audit');
const { loginLimiter } = require('../limits');
const signin = require('../services/signin');
const { now } = require('../helpers');

const router = express.Router();

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

function loginPage(res, opts) {
  return res.render('login', {
    title: 'Log in', next: '/', username: '', error: null, notice: null, ...opts,
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  let notice = null;
  if (req.query.expired) notice = 'Your session ended. Please log in again.';
  else if (req.query.next) notice = 'Please log in to continue.';
  return loginPage(res, { next: safeNext(req.query.next), notice });
});

async function startSession(req, res, user, nextUrl) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: 'Error', message: 'Could not start a session.' });
    req.session.userId = user.id;
    req.session.epoch = user.sessionEpoch || 0;
    req.session.authAt = Date.now();
    req.session.flash = [{ type: 'success', message: `Welcome, ${user.fullName || user.username}.` }];
    return res.redirect(safeNext(nextUrl));
  });
}

router.post('/login', loginLimiter, async (req, res) => {
  const nextUrl = safeNext(req.body.next);
  const check = await signin.checkPassword(req, req.body.username, req.body.password);
  if (!check.ok) {
    return res.status(check.status).render('login', {
      title: 'Log in', next: nextUrl, username: check.username, notice: null, error: check.message,
    });
  }
  const { user } = check;
  const patch = { failedLogins: 0, lockedUntil: null };

  if (user.totpEnabled) {
    await signin.patchUser(req.db, user.id, patch);
    return req.session.regenerate((err) => {
      if (err) return res.status(500).render('error', { title: 'Error', message: 'Could not start a session.' });
      req.session.pending2fa = { userId: user.id, at: Date.now(), tries: 0, next: nextUrl };
      return res.redirect('/login/verify');
    });
  }

  await signin.patchUser(req.db, user.id, { ...patch, lastLoginAt: now() });
  audit(req, 'login', 'users', user.id, 'Logged in', { user });
  return startSession(req, res, user, nextUrl);
});

// Second step: code from the authenticator app, or a recovery code.
function pending(req) {
  const p = req.session && req.session.pending2fa;
  if (!p || Date.now() - p.at > 5 * 60 * 1000) return null;
  return p;
}

router.get('/login/verify', (req, res) => {
  if (!pending(req)) return res.redirect('/login?expired=1');
  return res.render('login-verify', { title: 'Verify', error: null });
});

router.post('/login/verify', loginLimiter, async (req, res) => {
  const p = pending(req);
  if (!p) return res.redirect('/login?expired=1');
  const user = await req.db.get('users', p.userId);
  if (!user || user.active === false || !user.totpEnabled) return res.redirect('/login');

  const { ok, patch } = signin.checkCode(req, user, req.body.code);
  if (!ok) {
    p.tries += 1;
    if (p.tries >= 5) {
      delete req.session.pending2fa;
      await signin.recordFailedCode(req, user, 'Too many wrong verification codes');
      return res.redirect('/login?expired=1');
    }
    return res.status(401).render('login-verify', { title: 'Verify', error: 'That code is not correct. Check the time on your phone and try again.' });
  }

  delete req.session.pending2fa;
  await signin.patchUser(req.db, user.id, { ...patch, lastLoginAt: now(), failedLogins: 0, lockedUntil: null });
  audit(req, 'login', 'users', user.id, 'Logged in with two-step verification', { user });
  return startSession(req, res, user, p.next);
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout', 'users', req.user.id, 'Logged out');
  req.session.destroy(() => {
    res.clearCookie('kdla.sid');
    res.redirect('/login');
  });
});

module.exports = router;
