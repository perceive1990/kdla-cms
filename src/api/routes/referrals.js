'use strict';
const express = require('express');
const choices = require('../../choices');
const svc = require('../../services/referrals');
const { canSeeCase } = require('../../access');
const { mapByIds, fullName } = require('../../helpers');
const { adminOnly } = require('../auth');
const h = require('../http');

const router = express.Router();

/** A referral on a confidential case the user cannot open shows only that it exists. */
function out(r, c, user) {
  if (c && !canSeeCase(user, c)) {
    return {
      id: r.id, caseId: r.caseId, organizationId: r.organizationId, followUp: r.followUp, createdAt: r.createdAt, redacted: true,
    };
  }
  return { ...h.present(r), case: c ? { id: c.id, caseNumber: c.caseNumber, heading: c.heading, status: c.status } : null };
}

const gapWarnings = (gaps) => gaps.map((p) => `${fullName(p)} has not agreed to their information being shared with other organisations.`);

router.get('/referrals', async (req, res) => {
  const where = {};
  if (choices.followUpNeeds.includes(req.query.followUp)) where.followUp = req.query.followUp;
  if (req.query.caseId) where.caseId = String(req.query.caseId).slice(0, 60);
  if (req.query.organizationId) where.organizationId = String(req.query.organizationId).slice(0, 60);
  const { rows, meta } = await h.findPage(req, 'referrals', { where }, h.sortParam(req, ['createdAt', 'updatedAt'], ['createdAt', 'DESC']));
  const cases = await mapByIds(req.db, 'cases', rows.map((r) => r.caseId));
  h.sendList(res, rows.map((r) => out(r, cases[r.caseId], req.user)), meta);
});

/** Refer a case to a stakeholder organisation. The case is marked "Open Referred" unless "markReferred" is false. */
router.post('/referrals', async (req, res) => {
  const v = svc.readReferral(req.body);
  const { errors, kase } = await svc.validateReferral(req, v);
  h.failIfInvalid(errors);
  const doc = await svc.createReferral(req, v, kase);
  const fresh = await req.db.get('cases', kase.id);
  const body = { ...out(doc, fresh, req.user), warnings: gapWarnings(await svc.consentGaps(req.db, fresh)) };
  h.sendOne(res, body, 201, `${h.BASE}/referrals/${doc.id}`);
});

router.get('/referrals/:id', async (req, res) => {
  const { referral, kase } = await svc.getReferral(req, req.params.id);
  h.sendOne(res, { ...out(referral, kase, req.user), warnings: gapWarnings(await svc.consentGaps(req.db, kase)) });
});

/** Record a follow up. "status" (optional) also changes the case status; concluding is done on the case itself. */
router.post('/referrals/:id/follow-ups', async (req, res) => {
  const { referral, kase } = await svc.getReferral(req, req.params.id);
  const input = svc.readFollowUp(req.body);
  h.failIfInvalid(svc.validateFollowUp(input));
  const saved = await svc.addFollowUp(req, referral, kase, input);
  const fresh = kase ? await req.db.get('cases', kase.id) : null;
  h.sendOne(res, out(saved, fresh, req.user), 201);
});

router.delete('/referrals/:id', adminOnly, async (req, res) => {
  const { referral } = await svc.getReferral(req, req.params.id);
  await svc.deleteReferral(req, referral);
  res.status(204).end();
});

module.exports = router;
