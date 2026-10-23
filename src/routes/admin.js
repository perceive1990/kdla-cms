'use strict';
const express = require('express');
const config = require('../config');
const choices = require('../choices');
const { requireAdmin } = require('../auth');
const dir = require('../services/directory');
const adm = require('../services/admin');
const lists = require('../lists');
const { pagination, today } = require('../helpers');

const router = express.Router();
router.use(requireAdmin);

// ---------- Staff accounts ----------
// A checkbox that is not ticked is not sent at all, so "active" is read directly from the form.
const readUserForm = (body) => ({ ...dir.readUser(body), active: body.active === 'on' });

router.get('/users', async (req, res) => {
  const users = await req.db.find('users', { orderBy: ['username', 'ASC'] });
  res.render('admin/users', { title: 'Staff accounts', users });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { title: 'Add staff account', values: { active: true, role: 'officer' }, errors: {}, isNew: true });
});

router.post('/users', async (req, res) => {
  const v = readUserForm(req.body);
  const errors = await dir.validateNewUser(req.db, v, req.body.password);
  if (Object.keys(errors).length) return res.status(400).render('admin/user-form', { title: 'Add staff account', values: v, errors, isNew: true });
  await dir.createStaff(req, v, req.body.password);
  req.flash('success', `Account ${v.username} created. They will be asked to choose their own password at first login.`);
  return res.redirect('/admin/users');
});

router.get('/users/:id/edit', async (req, res) => {
  const u = await dir.getUser(req.db, req.params.id);
  return res.render('admin/user-form', { title: `Edit ${u.username}`, values: u, errors: {}, isNew: false });
});

router.post('/users/:id', async (req, res) => {
  const u = await dir.getUser(req.db, req.params.id);
  const v = readUserForm(req.body);
  const { errors, signOut } = await dir.updateStaff(req, u, v, {
    password: req.body.password, unlock: req.body.unlock === 'on', reset2fa: req.body.reset2fa === 'on',
  });
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/user-form', { title: `Edit ${u.username}`, values: { ...u, ...v, username: u.username }, errors, isNew: false });
  }
  req.flash('success', `Account ${u.username} updated.${signOut && u.id !== req.user.id ? ' They have been signed out.' : ''}`);
  if (signOut && u.id === req.user.id) req.session.epoch = (u.sessionEpoch || 0) + 1;
  return res.redirect('/admin/users');
});

// ---------- Projects ----------
router.get('/projects', async (req, res) => {
  const projects = await req.db.find('projects', { orderBy: ['startDate', 'DESC'] });
  res.render('admin/projects', { title: 'Projects', projects });
});

router.get('/projects/new', (req, res) => {
  res.render('admin/project-form', { title: 'Add project', values: { currency: 'ZMW' }, errors: {}, isNew: true });
});

router.post('/projects', async (req, res) => {
  const v = dir.readProject(req.body);
  const errors = dir.validateProject(v);
  if (Object.keys(errors).length) return res.status(400).render('admin/project-form', { title: 'Add project', values: v, errors, isNew: true });
  await dir.createProject(req, v);
  req.flash('success', 'Project added.');
  return res.redirect('/admin/projects');
});

router.get('/projects/:id/edit', async (req, res) => {
  const p = await dir.getProject(req.db, req.params.id);
  return res.render('admin/project-form', { title: `Edit ${p.title}`, values: p, errors: {}, isNew: false });
});

router.post('/projects/:id', async (req, res) => {
  const p = await dir.getProject(req.db, req.params.id);
  const v = dir.readProject(req.body);
  const errors = dir.validateProject(v);
  if (Object.keys(errors).length) return res.status(400).render('admin/project-form', { title: `Edit ${p.title}`, values: { ...p, ...v }, errors, isNew: false });
  await dir.updateProject(req, p, v);
  req.flash('success', 'Project updated.');
  return res.redirect('/admin/projects');
});

router.post('/projects/:id/delete', async (req, res) => {
  const p = await dir.getProject(req.db, req.params.id);
  try {
    await dir.deleteProject(req, p);
  } catch (e) {
    if (e.code !== 'in_use') throw e;
    req.flash('warning', e.message);
    return res.redirect('/admin/projects');
  }
  req.flash('success', 'Project deleted.');
  return res.redirect('/admin/projects');
});

// ---------- Drop-down lists (districts and offices) ----------
async function listsPage(req, res, extra = {}) {
  const sections = [];
  for (const [key, def] of Object.entries(lists.EDITABLE)) {
    sections.push({
      key, label: def.label, values: choices[key], used: await lists.usage(req.db, key), usedIn: def.used.map((u) => u[2]).join(' and '),
    });
  }
  res.status(extra.status || 200).render('admin/lists', {
    title: 'Drop-down lists', sections, errors: {}, drafts: {}, ...extra,
  });
}

router.get('/lists', (req, res) => listsPage(req, res));

router.post('/lists/:key', async (req, res) => {
  const { key } = req.params;
  if (!lists.EDITABLE[key]) return res.redirect('/admin/lists');
  const parsed = lists.parseList(req.body.values);
  if (parsed.error) return listsPage(req, res, { status: 400, errors: { [key]: parsed.error }, drafts: { [key]: req.body.values } });
  const { added, removed } = await lists.saveList(req, key, parsed.values);
  const label = lists.EDITABLE[key].label;
  const parts = [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean);
  req.flash('success', `${label} saved${parts.length ? `: ${parts.join('; ')}` : ''}.`);
  return res.redirect('/admin/lists');
});

// ---------- Audit trail ----------
router.get('/audit', async (req, res) => {
  const q = adm.auditQuery(req.query);
  const total = await req.db.count('audit', q);
  const pg = pagination(req, total);
  const entries = await req.db.find('audit', { ...q, orderBy: ['at', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const users = await req.db.find('users', { fields: ['id', 'username', 'fullName'], orderBy: ['username', 'ASC'] });
  res.render('admin/audit', {
    title: 'Audit trail', entries, pg, users, actions: adm.ACTIONS, entities: adm.AUDIT_ENTITIES, retention: config.auditRetentionDays,
  });
});

// ---------- Data export (backup and portability) ----------
router.get('/export', async (req, res) => {
  res.render('admin/export', { title: 'Data export', counts: await adm.recordCounts(req.db) });
});

router.post('/export', async (req, res) => {
  const out = await adm.exportAll(req);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kdla-cms-export-${today()}.json"`);
  res.send(JSON.stringify(out, null, 2));
});

module.exports = router;
