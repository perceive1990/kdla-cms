'use strict';
// Rules for referrals and their follow ups, shared by the web pages and the API.
const choices = require('../choices');
const { audit } = require('../audit');
const { canSeeCase } = require('../access');
const {
  newId, now, str, bool, mapByIds,
} = require('../helpers');
const { HttpError, notFound } = require('./errors');

function readReferral(body) {
  return {
    caseId: str(body.caseId),
    organizationId: str(body.organizationId),
    followUp: str(body.followUp) || 'Needs follow up',
    reason: str(body.reason, 2000),
    markReferred: body.markReferred === undefined ? true : bool(body.markReferred),
  };
}

async function validateReferral(req, v) {
  const errors = {};
  const c = v.caseId ? await req.db.get('cases', v.caseId) : null;
  if (!c || !canSeeCase(req.user, c)) errors.caseId = 'Select the case being referred.';
  if (!v.organizationId || !(await req.db.get('stakeholders', v.organizationId))) errors.organizationId = 'Select the organisation.';
  if (!choices.followUpNeeds.includes(v.followUp)) errors.followUp = 'Select whether follow up is needed.';
  return { errors, kase: c };
}

/** Clients on the case who have not agreed to their information being shared. */
async function consentGaps(db, c) {
  if (!c) return [];
  const people = await mapByIds(db, 'people', c.clientIds || []);
  return Object.values(people).filter((p) => p.consentShare !== 'yes');
}

async function createReferral(req, v, c) {
  const { markReferred, ...data } = v;
  const doc = { id: newId(), ...data, followUps: [], createdBy: req.user.id, createdAt: now(), updatedAt: now() };
  const saved = await req.db.create('referrals', doc);
  if (markReferred && c.status !== 'Open Referred') {
    const history = [...(c.history || []), { at: now(), by: req.user.id, action: 'Referred', status: 'Open Referred', from: c.status }];
    await req.db.replace('cases', { ...c, status: 'Open Referred', history, updatedAt: now() });
  }
  audit(req, 'create', 'referrals', doc.id, `Referred ${c.caseNumber}`);
  return saved;
}

/** Load a referral; refused when it belongs to a confidential case the user cannot open. */
async function getReferral(req, id) {
  const r = await req.db.get('referrals', id);
  if (!r) throw notFound('Referral');
  const c = await req.db.get('cases', r.caseId);
  if (c && !canSeeCase(req.user, c)) throw new HttpError(403, 'confidential', 'This referral belongs to a confidential case.');
  return { referral: r, kase: c };
}

function readFollowUp(body) {
  return { description: str(body.description, 3000), status: str(body.status), followUp: str(body.followUp) };
}

function validateFollowUp(input) {
  const errors = {};
  if (!input.description) errors.description = 'Describe what was done during the follow up.';
  if (input.status && !choices.caseStatuses.includes(input.status)) errors.status = 'Select a valid status.';
  if (input.status && input.status.startsWith('Concluded')) errors.status = 'To conclude the case, record its outcome on the case.';
  if (input.followUp && !choices.followUpNeeds.includes(input.followUp)) errors.followUp = 'Select whether further follow up is needed.';
  return errors;
}

async function addFollowUp(req, r, c, input) {
  const entry = {
    id: newId(), description: input.description, status: input.status, conductedBy: req.user.id, conductedOn: now(),
  };
  const updated = {
    ...r, followUps: [...(r.followUps || []), entry], followUp: input.followUp || r.followUp, updatedAt: now(),
  };
  const saved = await req.db.replace('referrals', updated);
  if (c && input.status && input.status !== c.status) {
    const history = [...(c.history || []), { at: now(), by: req.user.id, action: 'Status changed after follow up', status: input.status, from: c.status }];
    await req.db.replace('cases', { ...c, status: input.status, history, updatedAt: now() });
  }
  audit(req, 'update', 'referrals', r.id, 'Recorded follow up');
  return saved;
}

async function deleteReferral(req, r) {
  await req.db.remove('referrals', r.id);
  audit(req, 'delete', 'referrals', r.id, 'Deleted referral');
}

module.exports = {
  readReferral, validateReferral, consentGaps, createReferral, getReferral, readFollowUp, validateFollowUp, addFollowUp, deleteReferral,
};
