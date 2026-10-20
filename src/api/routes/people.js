'use strict';
const express = require('express');
const svc = require('../../services/people');
const { conflictCheck } = require('../../services/search');
const { visibleCase } = require('../../access');
const { bool } = require('../../helpers');
const { HttpError } = require('../../services/errors');
const { adminOnly } = require('../auth');
const h = require('../http');

const router = express.Router();
const SORTS = ['createdAt', 'updatedAt', 'lastName', 'firstName'];
const YES_NO = ['yes', 'no', 'Yes', 'No', 'YES', 'NO'];
const LISTS = { consentRecord: YES_NO, consentShare: YES_NO };

const summary = (p) => ({
  id: p.id, kind: p.kind, firstName: p.firstName, lastName: p.lastName, nrc: p.nrc || '', caseNumber: p.caseNumber || '', contact: p.contact || '',
});

/** 409 listing possible duplicates and conflicts of interest, so the client can review them and confirm. */
function matchesError(matches) {
  return new HttpError(409, 'possible_matches', 'Possible duplicates or conflicts of interest were found. Review them, then send the '
    + 'same request again with "confirmMatches": true to save anyway.', {
    matches: { duplicates: matches.duplicates.map(summary), conflicts: matches.conflicts.map(summary) },
  });
}

function kindOf(raw, { required = false } = {}) {
  if (!raw && !required) return undefined;
  if (!svc.KINDS.includes(raw)) throw h.invalid({ kind: `Use one of: ${svc.KINDS.join(', ')}.` });
  return raw;
}

router.get('/people', async (req, res) => {
  const q = svc.peopleQuery(req.query, kindOf(req.query.kind));
  const { rows, meta } = await h.findPage(req, 'people', q, h.sortParam(req, SORTS, ['createdAt', 'DESC']));
  h.sendList(res, rows.map(h.presentPerson), meta);
});

router.post('/people', async (req, res) => {
  const kind = kindOf(req.body.kind, { required: true });
  const v = svc.readPerson(req.body, kind);
  h.failIfInvalid({ ...(await svc.validatePerson(req.db, v, kind)), ...h.checkChoices(req.body, LISTS) });
  const { doc, matches } = await svc.createPerson(req, kind, v, { confirm: bool(req.body.confirmMatches) });
  if (!doc) throw matchesError(matches);
  h.sendOne(res, h.presentPerson(doc), 201, `${h.BASE}/people/${doc.id}`);
});

router.get('/people/:id', async (req, res) => {
  h.sendOne(res, h.presentPerson(await svc.getPerson(req.db, req.params.id)));
});

router.patch('/people/:id', async (req, res) => {
  if (req.body.kind !== undefined) {
    const p = await svc.getPerson(req.db, req.params.id);
    if (req.body.kind !== p.kind) throw h.invalid({ kind: 'The kind of record cannot be changed. Register the person again as the other kind.' });
  }
  const saved = await h.saveWithRetry(req, async () => {
    const p = await svc.getPerson(req.db, req.params.id);
    h.checkIfMatch(req, p);
    const v = svc.readPerson({ ...p, ...req.body }, p.kind);
    h.failIfInvalid({ ...(await svc.validatePerson(req.db, v, p.kind, p.id)), ...h.checkChoices(req.body, LISTS) });
    const { doc, matches } = await svc.updatePerson(req, p, v, { confirm: bool(req.body.confirmMatches), ifMatch: p._etag });
    if (!doc) throw matchesError(matches);
    return doc;
  });
  h.sendOne(res, h.presentPerson(saved));
});

router.delete('/people/:id', adminOnly, async (req, res) => {
  await svc.deletePerson(req, await svc.getPerson(req.db, req.params.id));
  res.status(204).end();
});

/** Cases (clients and other parties) or activity reports (attendees) linked to the person. */
router.get('/people/:id/links', async (req, res) => {
  const p = await svc.getPerson(req.db, req.params.id);
  const field = { client: 'clientIds', defendant: 'defendantIds' }[p.kind];
  const cases = field ? await req.db.find('cases', { where: { [field]: { $contains: p.id } }, orderBy: ['openedOn', 'DESC'] }) : [];
  const reports = p.kind === 'attendee'
    ? await req.db.find('reports', { where: { attendeeIds: { $contains: p.id } }, fields: ['id', 'heading', 'date', 'activityType', 'district'], orderBy: ['date', 'DESC'] })
    : [];
  res.json({
    cases: cases.map((c) => visibleCase(req.user, c)).map((c) => (c.redacted ? c : {
      id: c.id, caseNumber: c.caseNumber, heading: c.heading, status: c.status, openedOn: c.openedOn, closedOn: c.closedOn || '', officerId: c.officerId,
    })),
    reports,
  });
});

/** Everything held about one person, for a data subject access request (Data Protection Act 2021). Administrators only. */
router.get('/people/:id/personal-data', adminOnly, async (req, res) => {
  const p = await svc.getPerson(req.db, req.params.id);
  res.json(await svc.personalData(req, p));
});

/** Conflict of interest check by name and/or NRC before taking on a new client. */
router.get('/conflicts', async (req, res) => {
  const r = await conflictCheck(req, req.query);
  if (!r.searched) throw h.invalid({ name: 'Give a name, an NRC number, or both.' });
  res.json({
    name: r.name,
    nrc: r.nrc,
    data: r.results.map((x) => ({ person: summary(x.p), exactMatch: x.exact, cases: x.cases.map(({ teamIds, ...c }) => c) })),
  });
});

module.exports = router;
