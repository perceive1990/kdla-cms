'use strict';
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { verifyPassword, needs2faSetup } = require('../auth');
const totp = require('../totp');
const theme = require('../theme');
const { audit, clientIp } = require('../audit');
const { str } = require('../helpers');
const acct = require('../services/account');
const tokens = require('../api/tokens');

const router = express.Router();

/** Save user changes; when signOutOthers is set, other devices are logged out but this one stays in. */
async function saveUser(req, patch, { signOutOthers = false } = {}) {
  const next = await acct.updateSelf(req, patch, { bumpEpoch: signOutOthers });
  if (signOutOthers) req.session.epoch = next.sessionEpoch;
  return next;
}

// ---------- Appearance ----------
router.get('/appearance', (req, res) => {
  res.render('account/appearance', {
    title: 'Appearance', modes: theme.MODES, accents: theme.ACCENTS, sizes: theme.TEXT_SIZES, current: theme.themeOf(req.user),
  });
});

router.post('/appearance', async (req, res) => {
  const t = theme.readTheme(req.body, req.user.theme);
  await saveUser(req, { theme: t });
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true, theme: t });
  req.flash('success', 'Appearance saved.');
  return res.redirect('/account/appearance');
});

// ---------- Password ----------
router.get('/password', (req, res) => {
  res.render('account/password', { title: 'Change password', errors: {} });
});

router.post('/password', async (req, res) => {
  const { current, password } = req.body;
  const { errors, user } = await acct.changePassword(req, { current, password, confirm: req.body.confirm || '' });
  if (Object.keys(errors).length) return res.status(400).render('account/password', { title: 'Change password', errors });
  req.session.epoch = user.sessionEpoch;
  req.flash('success', 'Your password has been changed. Any other devices and API tokens have been signed out.');
  return res.redirect(needs2faSetup(req.user) ? '/account/security' : '/');
});

// ---------- Security: two-step verification ----------
async function qrSvg(secret, username) {
  const url = totp.otpauthUrl({ secret, account: username, issuer: `${config.orgName} Case Management` });
  return QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

router.get('/security', async (req, res) => {
  const u = req.user;
  let setup = null;
  if (!u.totpEnabled) {
    // Keep the same pending secret while the user is setting up, so the QR code does not change on reload.
    if (!req.session.pendingTotp) req.session.pendingTotp = totp.generateSecret();
    const secret = req.session.pendingTotp;
    setup = { secret, grouped: secret.match(/.{1,4}/g).join(' '), svg: await qrSvg(secret, u.username) };
  }
  res.render('account/security', {
    title: 'Password and security', setup, codes: null, error: null, required: needs2faSetup(u),
    recoveryLeft: (u.recoveryCodes || []).length,
  });
});

router.post('/security/enable', async (req, res) => {
  const secret = req.session.pendingTotp;
  if (!secret || req.user.totpEnabled) return res.redirect('/account/security');
  const step = totp.verify(secret, req.body.code);
  if (step === null) {
    const setup = { secret, grouped: secret.match(/.{1,4}/g).join(' '), svg: await qrSvg(secret, req.user.username) };
    return res.status(400).render('account/security', {
      title: 'Password and security', setup, codes: null, required: needs2faSetup(req.user), recoveryLeft: 0,
      error: 'That code is not correct. Make sure the time on your phone is set automatically, then try the newest code.',
    });
  }
  const codes = totp.generateRecoveryCodes();
  await saveUser(req, {
    totpEnabled: true, totpSecret: secret, totpLastStep: step, recoveryCodes: codes.map(totp.hashRecoveryCode),
  }, { signOutOthers: true });
  delete req.session.pendingTotp;
  audit(req, 'security', 'users', req.user.id, 'Turned on two-step verification');
  return res.render('account/security', {
    title: 'Password and security', setup: null, codes, error: null, required: false, recoveryLeft: codes.length,
  });
});

router.post('/security/recovery-codes', async (req, res) => {
  if (!req.user.totpEnabled) return res.redirect('/account/security');
  const check = await verifyPassword(req.body.password || '', req.user.passwordHash);
  if (!check.ok) {
    req.flash('danger', 'Your password is not correct.');
    return res.redirect('/account/security');
  }
  const codes = totp.generateRecoveryCodes();
  await saveUser(req, { recoveryCodes: codes.map(totp.hashRecoveryCode) });
  audit(req, 'security', 'users', req.user.id, 'Created new recovery codes');
  return res.render('account/security', {
    title: 'Password and security', setup: null, codes, error: null, required: false, recoveryLeft: codes.length,
  });
});

router.post('/security/disable', async (req, res) => {
  if (!req.user.totpEnabled) return res.redirect('/account/security');
  if (needs2faSetup({ ...req.user, totpEnabled: false })) {
    req.flash('warning', 'Two-step verification is required for your account and cannot be turned off.');
    return res.redirect('/account/security');
  }
  const check = await verifyPassword(req.body.password || '', req.user.passwordHash);
  if (!check.ok) {
    req.flash('danger', 'Your password is not correct.');
    return res.redirect('/account/security');
  }
  await saveUser(req, {
    totpEnabled: false, totpSecret: null, totpLastStep: null, recoveryCodes: [],
  }, { signOutOthers: true });
  audit(req, 'security', 'users', req.user.id, 'Turned off two-step verification');
  req.flash('success', 'Two-step verification is off.');
  return res.redirect('/account/security');
});

router.post('/security/sign-out-others', async (req, res) => {
  await saveUser(req, {}, { signOutOthers: true });
  audit(req, 'security', 'users', req.user.id, 'Signed out all other devices');
  req.flash('success', 'All your other devices and API tokens have been signed out.');
  return res.redirect('/account/security');
});

// ---------- API access: personal access tokens for scripts and reports ----------
const DAY_CHOICES = [30, 90, 180, 365];
const dayChoices = () => {
  const list = DAY_CHOICES.filter((d) => d <= config.api.personalTokenMaxDays);
  return list.length ? list : [config.api.personalTokenMaxDays];
};

async function apiPage(req, res, extra = {}) {
  const list = await tokens.listTokens(req.db, req.user);
  res.setHeader('Cache-Control', 'no-store'); // a new token is shown on this page once
  return res.status(extra.status || 200).render('account/api', {
    title: 'API access',
    tokens: list.map((d) => tokens.publicToken(d)),
    dayChoices: dayChoices(),
    apiEnabled: config.api.enabled,
    blocked: req.user.mustChangePassword || needs2faSetup(req.user),
    newToken: null,
    errors: {},
    values: { days: 90 },
    ...extra,
  });
}

router.get('/api', (req, res) => apiPage(req, res));

router.post('/api/tokens', async (req, res) => {
  if (!config.api.enabled || req.user.mustChangePassword || needs2faSetup(req.user)) return res.redirect('/account/api');
  const label = str(req.body.label, 80);
  const days = parseInt(req.body.days, 10);
  const errors = {};
  if (!label) errors.label = 'Give the token a name, for example "Power BI report".';
  if (!dayChoices().includes(days)) errors.days = 'Choose how long the token should last.';
  const check = await verifyPassword(req.body.password || '', req.user.passwordHash);
  if (!check.ok) errors.password = 'Your password is not correct.';
  if (Object.keys(errors).length) return apiPage(req, res, { status: 400, errors, values: { label, days } });
  const { token, doc } = await tokens.issueToken(req.db, req.user, {
    kind: 'personal', label, days, ip: clientIp(req),
  });
  audit(req, 'security', 'users', req.user.id, `Created personal API token "${doc.label}" (${days} days)`);
  return apiPage(req, res, { newToken: { token, label: doc.label, expiresAt: doc.expiresAt } });
});

router.post('/api/tokens/:id/revoke', async (req, res) => {
  const doc = await tokens.revokeToken(req.db, req.user, req.params.id);
  if (doc) {
    audit(req, 'security', 'users', req.user.id, `Revoked API token "${doc.label}"`);
    req.flash('success', `Token "${doc.label}" revoked. Anything using it can no longer reach the system.`);
  }
  return res.redirect('/account/api');
});

module.exports = router;
