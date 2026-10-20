'use strict';
// Stakeholder organisations, projects and staff accounts.
const express = require('express');
const choices = require('../../choices');
const dir = require('../../services/directory');
const { isAdmin } = require('../../access');
const { bool } = require('../../helpers');
const { adminOnly } = require('../auth');
const tokens = require('../tokens');
const h = require('../http');

const router = express.Router();
const USER_LISTS = {
  role: choices.roles, category: choices.userCategories, qualification: choices.qualificationLevels, office: choices.offices,
};
const PROJECT_LISTS = { currency: dir.CURRENCIES };

// ---------- Stakeholder organisations ----------
router.get('/stakeholders', async (req, res) => {
  const { rows, meta } = await h.findPage(req, 'stakeholders', dir.stakeholderQuery(req.query), h.sortParam(req, ['name', 'createdAt'], ['name', 'ASC']));
  h.sendList(res, rows.map((s) => h.present(s)), meta);
});

router.post('/stakeholders', async (req, res) => {
  const v = dir.readStakeholder(req.body);
  h.failIfInvalid(dir.validateStakeholder(v));
  const doc = await dir.createStakeholder(req, v);
  h.sendOne(res, h.present(doc), 201, `${h.BASE}/stakeholders/${doc.id}`);
});

router.get('/stakeholders/:id', async (req, res) => {
  h.sendOne(res, h.present(await dir.getStakeholder(req.db, req.params.id)));
});

router.patch('/stakeholders/:id', async (req, res) => {
  const saved = await h.saveWithRetry(req, async () => {
    const s = await dir.getStakeholder(req.db, req.params.id);
    h.checkIfMatch(req, s);
    const v = dir.readStakeholder({ ...s, ...req.body });
    h.failIfInvalid(dir.validateStakeholder(v));
    return dir.updateStakeholder(req, s, v, { ifMatch: s._etag });
  });
  h.sendOne(res, h.present(saved));
});

router.delete('/stakeholders/:id', adminOnly, async (req, res) => {
  await dir.deleteStakeholder(req, await dir.getStakeholder(req.db, req.params.id));
  res.status(204).end();
});

// ---------- Projects (everyone can read; administrators manage) ----------
router.get('/projects', async (req, res) => {
  const projects = await req.db.find('projects', { orderBy: ['startDate', 'DESC'] });
  res.json({ data: projects.map((p) => h.present(p)) });
});

router.post('/projects', adminOnly, async (req, res) => {
  const v = dir.readProject(req.body);
  h.failIfInvalid({ ...dir.validateProject(v), ...h.checkChoices(req.body, PROJECT_LISTS) });
  const doc = await dir.createProject(req, v);
  h.sendOne(res, h.present(doc), 201, `${h.BASE}/projects/${doc.id}`);
});

router.get('/projects/:id', async (req, res) => {
  h.sendOne(res, h.present(await dir.getProject(req.db, req.params.id)));
});

router.patch('/projects/:id', adminOnly, async (req, res) => {
  const p = await dir.getProject(req.db, req.params.id);
  h.checkIfMatch(req, p);
  const v = dir.readProject({ ...p, ...req.body });
  h.failIfInvalid({ ...dir.validateProject(v), ...h.checkChoices(req.body, PROJECT_LISTS) });
  h.sendOne(res, h.present(await dir.updateProject(req, p, v)));
});

router.delete('/projects/:id', adminOnly, async (req, res) => {
  await dir.deleteProject(req, await dir.getProject(req.db, req.params.id));
  res.status(204).end();
});

// ---------- Staff accounts ----------
// Everyone can list colleagues (to assign tasks and cases); administrators see the full account details.
router.get('/users', async (req, res) => {
  const where = {};
  if (choices.roles.includes(req.query.role)) where.role = req.query.role;
  let users = await req.db.find('users', { where, orderBy: ['username', 'ASC'] });
  if (req.query.active !== undefined) users = users.filter((u) => (u.active !== false) === bool(req.query.active));
  const full = isAdmin(req.user);
  res.json({ data: users.map((u) => dir.publicUser(u, { full })) });
});

router.get('/users/:id', async (req, res) => {
  const u = await dir.getUser(req.db, req.params.id);
  res.json(dir.publicUser(u, { full: isAdmin(req.user) || u.id === req.user.id }));
});

/** Create a staff account with a temporary password; they choose their own at first sign-in. */
router.post('/users', adminOnly, async (req, res) => {
  const v = dir.readUser(req.body);
  const password = String(req.body.password || '');
  h.failIfInvalid({ ...(await dir.validateNewUser(req.db, v, password)), ...h.checkChoices(req.body, USER_LISTS) });
  const doc = await dir.createStaff(req, v, password);
  res.status(201).set('Location', `${h.BASE}/users/${doc.id}`).json(dir.publicUser(doc, { full: true }));
});

/**
 * Change an account: fullName, email, role, category, qualification, office, active,
 * plus "password" (new temporary password), "unlock": true, "resetTwoStep": true.
 */
router.patch('/users/:id', adminOnly, async (req, res) => {
  const u = await dir.getUser(req.db, req.params.id);
  const v = dir.readUser({ ...u, ...req.body });
  h.failIfInvalid(h.checkChoices(req.body, USER_LISTS));
  const { errors, doc, signOut } = await dir.updateStaff(req, u, v, {
    password: String(req.body.password || ''), unlock: bool(req.body.unlock), reset2fa: bool(req.body.resetTwoStep),
  });
  h.failIfInvalid(errors);
  // An administrator changing their own account stays signed in on this token.
  if (signOut && u.id === req.user.id) await tokens.rebind(req.db, req.apiToken, doc.sessionEpoch || 0);
  res.json({ ...dir.publicUser(doc, { full: true }), signedOut: signOut && u.id !== req.user.id });
});

module.exports = router;
