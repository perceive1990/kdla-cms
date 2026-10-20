'use strict';
const express = require('express');
const choices = require('../../choices');
const svc = require('../../services/cases');
const { checkCase } = require('../../conflicts');
const { mapByIds, today, daysBetween } = require('../../helpers');
const { forbidden, notFound } = require('../../services/errors');
const { adminOnly } = require('../auth');
const { attachmentRoutes } = require('../files');
const h = require('../http');

const router = express.Router();
const SORTS = ['updatedAt', 'createdAt', 'openedOn', 'caseNumber'];
const LISTS = { caseTypes: choices.caseTypes, services: choices.legalServices };

const out = (c) => ({ ...h.presentWithFiles(c, 'cases'), daysOpen: daysBetween(c.openedOn, c.closedOn || today()) });
const personSummary = (p) => (p ? {
  id: p.id, kind: p.kind, firstName: p.firstName, lastName: p.lastName, nrc: p.nrc || '', caseNumber: p.caseNumber || '',
} : null);

router.get('/cases', async (req, res) => {
  const q = svc.caseQuery(req.user, req.query);
  const { rows, meta } = await h.findPage(req, 'cases', q, h.sortParam(req, SORTS, ['updatedAt', 'DESC']));
  h.sendList(res, rows.map(out), meta);
});

router.post('/cases', async (req, res) => {
  // Same starting values as the web form: open, today, the signed-in officer and their office.
  const v = svc.readCase({
    status: 'Open Active Case', openedOn: today(), officerId: req.user.id, office: req.user.office || '', ...req.body,
  });
  h.failIfInvalid({ ...(await svc.validateCase(req.db, v)), ...h.checkChoices(req.body, LISTS) });
  const doc = await svc.createCase(req, v, []);
  h.sendOne(res, out(doc), 201, `${h.BASE}/cases/${doc.id}`);
});

router.get('/cases/:id', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  svc.logView(req, c);
  h.sendOne(res, out(c));
});

router.patch('/cases/:id', async (req, res) => {
  const saved = await h.saveWithRetry(req, async () => {
    const c = await svc.getCase(req, req.params.id);
    h.checkIfMatch(req, c);
    if (('restricted' in req.body || 'teamIds' in req.body) && !svc.mayChangeAccess(req.user, c)) {
      throw forbidden('Only the responsible officer, the person who opened the case or an administrator can change who can see it.');
    }
    const v = svc.protectAccessFields(req.user, c, svc.readCase({ ...c, ...req.body }));
    h.failIfInvalid({ ...(await svc.validateCase(req.db, v)), ...h.checkChoices(req.body, LISTS) });
    return svc.updateCase(req, c, v, { ifMatch: c._etag });
  });
  h.sendOne(res, out(saved));
});

router.delete('/cases/:id', adminOnly, async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  await svc.deleteCase(req, c);
  res.status(204).end();
});

// The clients and other parties on the case, in full.
router.get('/cases/:id/parties', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const people = await mapByIds(req.db, 'people', [...(c.clientIds || []), ...(c.defendantIds || [])]);
  res.json({
    clients: (c.clientIds || []).map((id) => people[id]).filter(Boolean).map(h.presentPerson),
    otherParties: (c.defendantIds || []).map((id) => people[id]).filter(Boolean).map(h.presentPerson),
  });
});

router.get('/cases/:id/conflicts', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const people = await mapByIds(req.db, 'people', [...(c.clientIds || []), ...(c.defendantIds || [])]);
  const alerts = await checkCase(req.db, c, people);
  res.json({ data: alerts.map((a) => ({ reason: a.reason, party: personSummary(a.party), match: personSummary(a.match) })) });
});

// ---------- Case diary ----------
router.get('/cases/:id/notes', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const notes = await svc.listNotes(req.db, c);
  res.json({ data: notes.map((n) => h.present(n)), totalMinutes: notes.reduce((s, n) => s + (n.minutes || 0), 0) });
});

router.post('/cases/:id/notes', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const n = svc.readNote(req.body);
  h.failIfInvalid(svc.validateNote(n));
  const note = await svc.addNote(req, c, n);
  h.sendOne(res, h.present(note), 201, `${h.BASE}/cases/${c.id}/notes/${note.id}`);
});

router.get('/cases/:id/notes/:noteId', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const note = await req.db.get('caseNotes', req.params.noteId, c.id);
  if (!note) throw notFound('Diary entry');
  h.sendOne(res, h.present(note));
});

router.delete('/cases/:id/notes/:noteId', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  await svc.deleteNote(req, c, req.params.noteId);
  res.status(204).end();
});

attachmentRoutes(router, 'cases', (req) => svc.getCase(req, req.params.id));

module.exports = router;
