'use strict';
const express = require('express');
const choices = require('../../choices');
const svc = require('../../services/reports');
const { mapByIds, today, tally } = require('../../helpers');
const { adminOnly } = require('../auth');
const { attachmentRoutes } = require('../files');
const h = require('../http');

const router = express.Router();
const SORTS = ['date', 'createdAt', 'updatedAt'];
const out = (r) => h.presentWithFiles(r, 'reports');

router.get('/reports', async (req, res) => {
  const { rows, meta } = await h.findPage(req, 'reports', svc.reportQuery(req.query), h.sortParam(req, SORTS, ['date', 'DESC']));
  h.sendList(res, rows.map(out), meta);
});

router.post('/reports', async (req, res) => {
  const v = svc.readReport({ date: today(), compiledById: req.user.id, ...req.body });
  h.failIfInvalid(await svc.validateReport(req.db, v));
  const doc = await svc.createReport(req, v, []);
  h.sendOne(res, out(doc), 201, `${h.BASE}/reports/${doc.id}`);
});

router.get('/reports/:id', async (req, res) => {
  h.sendOne(res, out(await svc.getReport(req.db, req.params.id)));
});

router.patch('/reports/:id', async (req, res) => {
  const saved = await h.saveWithRetry(req, async () => {
    const r = await svc.getReport(req.db, req.params.id);
    h.checkIfMatch(req, r);
    const v = svc.readReport({ ...r, ...req.body });
    h.failIfInvalid(await svc.validateReport(req.db, v));
    return svc.updateReport(req, r, v, { ifMatch: r._etag });
  });
  h.sendOne(res, out(saved));
});

router.delete('/reports/:id', adminOnly, async (req, res) => {
  await svc.deleteReport(req, await svc.getReport(req.db, req.params.id));
  res.status(204).end();
});

/** Registered attendees with totals by age category and disability, as on the report page. */
router.get('/reports/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const people = Object.values(await mapByIds(req.db, 'people', r.attendeeIds));
  res.json({
    data: people.map(h.presentPerson),
    byAgeCategory: tally(people, 'ageCategory', choices.ageCategories),
    withDisability: people.filter((p) => p.disability === 'Disabled').length,
    otherParticipants: r.otherParticipants || 0,
  });
});

/**
 * Attendance register: add up to 200 people at once.
 * { "rows": [{ firstName, lastName, ageCategory, age, nrc, contact, disability, location }], "consentRecord": "yes", "consentShare": "no" }
 * Nothing is saved if any row has a problem. People already registered with the same NRC are linked, not added twice.
 */
router.post('/reports/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  if (!Array.isArray(req.body.rows)) throw h.invalid({ rows: 'Send "rows" as a list of attendees.' });
  const result = await svc.addAttendees(req, r, req.body.rows, { consentRecord: req.body.consentRecord, consentShare: req.body.consentShare });
  if (result.empty) throw h.invalid({ rows: 'Enter at least one attendee.' });
  if (result.rowErrors && Object.keys(result.rowErrors).length) {
    const err = h.invalid({ rows: 'Some rows need attention. Nothing was saved.' });
    err.rowErrors = result.rowErrors;
    throw err;
  }
  res.json({ added: result.added, linked: result.linked, report: out(result.report) });
});

attachmentRoutes(router, 'reports', (req) => svc.getReport(req.db, req.params.id));

module.exports = router;
