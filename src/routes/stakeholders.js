'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { visibleMap } = require('../access');
const dir = require('../services/directory');
const { pagination, mapByIds } = require('../helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = dir.stakeholderQuery(req.query);
  const total = await req.db.count('stakeholders', q);
  const pg = pagination(req, total);
  const stakeholders = await req.db.find('stakeholders', { ...q, orderBy: ['name', 'ASC'], offset: pg.offset, limit: pg.pageSize });
  res.render('stakeholders/list', { title: 'Stakeholder organisations', stakeholders, pg });
});

router.get('/new', (req, res) => {
  res.render('stakeholders/form', { title: 'Add stakeholder organisation', values: {}, errors: {}, isNew: true });
});

router.post('/', async (req, res) => {
  const v = dir.readStakeholder(req.body);
  const errors = dir.validateStakeholder(v);
  if (Object.keys(errors).length) return res.status(400).render('stakeholders/form', { title: 'Add stakeholder organisation', values: v, errors, isNew: true });
  const doc = await dir.createStakeholder(req, v);
  req.flash('success', `${doc.name} added.`);
  return res.redirect(`/stakeholders/${doc.id}`);
});

router.get('/:id', async (req, res) => {
  const s = await dir.getStakeholder(req.db, req.params.id);
  const referrals = await req.db.find('referrals', { where: { organizationId: s.id }, orderBy: ['createdAt', 'DESC'] });
  const cases = visibleMap(req.user, await mapByIds(req.db, 'cases', referrals.map((r) => r.caseId)));
  return res.render('stakeholders/show', { title: s.name, s, referrals, cases });
});

router.get('/:id/edit', async (req, res) => {
  const s = await dir.getStakeholder(req.db, req.params.id);
  return res.render('stakeholders/form', { title: `Edit ${s.name}`, values: s, errors: {}, isNew: false });
});

router.post('/:id', async (req, res) => {
  const s = await dir.getStakeholder(req.db, req.params.id);
  const v = dir.readStakeholder(req.body);
  const errors = dir.validateStakeholder(v);
  if (Object.keys(errors).length) return res.status(400).render('stakeholders/form', { title: `Edit ${s.name}`, values: { ...s, ...v }, errors, isNew: false });
  await dir.updateStakeholder(req, s, v, { ifMatch: req.body._etag });
  req.flash('success', 'Organisation updated.');
  return res.redirect(`/stakeholders/${s.id}`);
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const s = await dir.getStakeholder(req.db, req.params.id);
  try {
    await dir.deleteStakeholder(req, s);
  } catch (e) {
    if (e.code !== 'in_use') throw e;
    req.flash('warning', e.message);
    return res.redirect(`/stakeholders/${s.id}`);
  }
  req.flash('success', `${s.name} deleted.`);
  return res.redirect('/stakeholders');
});

module.exports = router;
