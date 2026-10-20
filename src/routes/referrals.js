'use strict';
const express = require('express');
const choices = require('../choices');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { visibleWhere, canSeeCase, visibleMap } = require('../access');
const svc = require('../services/referrals');
const {
  str, mapByIds, pagination, today, fullName,
} = require('../helpers');

const router = express.Router();

async function formLists(req) {
  const [cases, orgs] = await Promise.all([
    req.db.find('cases', { where: visibleWhere(req.user, {}), fields: ['id', 'caseNumber', 'heading', 'status'], orderBy: ['updatedAt', 'DESC'] }),
    req.db.find('stakeholders', { fields: ['id', 'name'], orderBy: ['name', 'ASC'] }),
  ]);
  return { cases, orgs };
}

router.get('/', async (req, res) => {
  const where = {};
  if (choices.followUpNeeds.includes(req.query.followUp)) where.followUp = req.query.followUp;
  const total = await req.db.count('referrals', { where });
  const pg = pagination(req, total);
  const referrals = await req.db.find('referrals', { where, orderBy: ['createdAt', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const cases = visibleMap(req.user, await mapByIds(req.db, 'cases', referrals.map((r) => r.caseId)));
  const orgs = await mapByIds(req.db, 'stakeholders', referrals.map((r) => r.organizationId));
  res.render('referrals/list', { title: 'Referrals', referrals, cases, orgs, pg });
});

router.get('/new', async (req, res) => {
  const values = { caseId: str(req.query.case), followUp: 'Needs follow up', markReferred: true };
  const c = values.caseId ? await req.db.get('cases', values.caseId) : null;
  const gaps = c && canSeeCase(req.user, c) ? await svc.consentGaps(req.db, c) : [];
  res.render('referrals/form', { title: 'New referral', values, errors: {}, gaps, ...(await formLists(req)) });
});

router.post('/', async (req, res) => {
  // A checkbox that is not ticked is not sent at all, so read it directly here.
  const v = { ...svc.readReferral(req.body), markReferred: req.body.markReferred === 'on' };
  const { errors, kase: c } = await svc.validateReferral(req, v);
  if (Object.keys(errors).length) {
    const gaps = c && canSeeCase(req.user, c) ? await svc.consentGaps(req.db, c) : [];
    return res.status(400).render('referrals/form', { title: 'New referral', values: v, errors, gaps, ...(await formLists(req)) });
  }
  const doc = await svc.createReferral(req, v, c);
  req.flash('success', 'Referral recorded. You can print a referral letter from this page.');
  return res.redirect(`/referrals/${doc.id}`);
});

async function renderShow(req, res, r, c, status, extra = {}) {
  const org = await req.db.get('stakeholders', r.organizationId);
  const users = await mapByIds(req.db, 'users', [r.createdBy, ...(r.followUps || []).map((f) => f.conductedBy)]);
  const gaps = await svc.consentGaps(req.db, c);
  return res.status(status).render('referrals/show', {
    title: 'Referral', r, c, org, users, gaps, errors: {}, values: {}, ...extra,
  });
}

router.get('/:id', async (req, res) => {
  const { referral, kase } = await svc.getReferral(req, req.params.id);
  return renderShow(req, res, referral, kase, 200);
});

// Printable referral letter on KDLA letterhead.
router.get('/:id/letter', async (req, res) => {
  const { referral: r, kase: c } = await svc.getReferral(req, req.params.id);
  const [org, clients, author] = await Promise.all([
    req.db.get('stakeholders', r.organizationId),
    c ? mapByIds(req.db, 'people', c.clientIds || []) : {},
    req.db.get('users', r.createdBy),
  ]);
  const officer = c ? await req.db.get('users', c.officerId) : null;
  audit(req, 'view', 'referrals', r.id, `Printed referral letter for ${c ? c.caseNumber : 'case'}`);
  res.render('referrals/letter', {
    title: 'Referral letter', r, c, org, clients: Object.values(clients), author, officer, date: today(), fullName,
  });
});

// Record a follow up. Optionally updates the case status too.
router.post('/:id/follow-ups', async (req, res) => {
  const { referral: r, kase: c } = await svc.getReferral(req, req.params.id);
  const input = svc.readFollowUp(req.body);
  const errors = svc.validateFollowUp(input);
  if (Object.keys(errors).length) {
    return renderShow(req, res, r, c, 400, { errors, values: { description: input.description, status: input.status } });
  }
  await svc.addFollowUp(req, r, c, input);
  req.flash('success', 'Follow up recorded.');
  return res.redirect(`/referrals/${r.id}`);
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const { referral } = await svc.getReferral(req, req.params.id);
  await svc.deleteReferral(req, referral);
  req.flash('success', 'Referral deleted.');
  return res.redirect('/referrals');
});

module.exports = router;
