'use strict';
const express = require('express');
const choices = require('../choices');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const svc = require('../services/reports');
const { saveUploads } = require('../services/attachments');
const {
  mapByIds, pagination, toCsv, sendCsv, fullName, tally, today,
} = require('../helpers');

const router = express.Router();

async function formLists(db) {
  const [attendees, users, projects] = await Promise.all([
    db.find('people', { where: { kind: 'attendee' }, fields: ['id', 'firstName', 'lastName', 'activity'], orderBy: ['lastName', 'ASC'] }),
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] }),
    db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] }),
  ]);
  return { attendees, users, projects };
}

router.get('/', async (req, res) => {
  const q = svc.reportQuery(req.query);
  const total = await req.db.count('reports', q);
  const pg = pagination(req, total);
  const reports = await req.db.find('reports', { ...q, orderBy: ['date', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const users = await mapByIds(req.db, 'users', reports.map((r) => r.compiledById));
  res.render('reports/list', { title: 'Activity reports', reports, users, pg });
});

router.get('/export.csv', async (req, res) => {
  const reports = await req.db.find('reports', { ...svc.reportQuery(req.query), orderBy: ['date', 'ASC'] });
  const users = await mapByIds(req.db, 'users', reports.map((r) => r.compiledById));
  const att = await mapByIds(req.db, 'people', reports.flatMap((r) => r.attendeeIds || []));
  const byCat = (r, cat) => (r.attendeeIds || []).filter((id) => att[id] && att[id].ageCategory === cat).length;
  const disabled = (r) => (r.attendeeIds || []).filter((id) => att[id] && att[id].disability === 'Disabled').length;
  const csv = toCsv([
    { label: 'Date', value: 'date' },
    { label: 'Activity number', value: 'activityNumber' },
    { label: 'Type of activity', value: 'activityType' },
    { label: 'Heading', value: 'heading' },
    { label: 'District', value: 'district' },
    { label: 'Venue', value: 'location' },
    { label: 'Registered attendees', value: (r) => (r.attendeeIds || []).length },
    ...choices.ageCategories.map((cat) => ({ label: `Attendees: ${cat}`, value: (r) => byCat(r, cat) })),
    { label: 'Attendees with a disability', value: disabled },
    { label: 'Other participants (unregistered)', value: 'otherParticipants' },
    { label: 'Immediate results', value: 'immediateResults' },
    { label: 'Compiled by', value: (r) => (users[r.compiledById] ? users[r.compiledById].fullName || users[r.compiledById].username : '') },
  ], reports);
  audit(req, 'export', 'reports', null, `Exported ${reports.length} reports to CSV`);
  sendCsv(res, `activity-reports-${today()}.csv`, csv);
});

router.get('/new', async (req, res) => {
  const values = { date: today(), compiledById: req.user.id, attendeeIds: [] };
  res.render('reports/form', { title: 'New activity report', values, errors: {}, isNew: true, ...(await formLists(req.db)) });
});

router.post('/', async (req, res) => {
  const v = svc.readReport(req.body);
  const errors = await svc.validateReport(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('reports/form', { title: 'New activity report', values: v, errors, isNew: true, ...(await formLists(req.db)) });
  }
  const doc = await svc.createReport(req, v, await saveUploads(req.files, req.user));
  req.flash('success', 'Report created. You can now add the attendance register.');
  return res.redirect(`/reports/${doc.id}`);
});

router.get('/:id', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const attendees = Object.values(await mapByIds(req.db, 'people', r.attendeeIds));
  attendees.sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const users = await mapByIds(req.db, 'users', [r.compiledById, ...(r.attachments || []).map((a) => a.uploadedBy)]);
  const project = r.projectId ? await req.db.get('projects', r.projectId) : null;
  return res.render('reports/show', {
    title: r.heading, r, attendees, users, project,
    byCategory: tally(attendees, 'ageCategory', choices.ageCategories),
    disabledCount: attendees.filter((a) => a.disability === 'Disabled').length,
  });
});

// Attendance register: add many attendees at once and link them to this report.
const blankRows = (n) => Array.from({ length: n }, () => ({}));

router.get('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  res.render('reports/attendees', { title: 'Attendance register', r, rows: blankRows(10), rowErrors: {}, consent: {} });
});

router.post('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const raw = req.body.rows ? Object.values(req.body.rows) : [];
  const consent = { consentRecord: req.body.consentRecord, consentShare: req.body.consentShare };
  const result = await svc.addAttendees(req, r, raw, consent);
  if (result.empty) {
    req.flash('warning', 'Enter at least one attendee.');
    return res.redirect(`/reports/${r.id}/attendees`);
  }
  if (result.rowErrors && Object.keys(result.rowErrors).length) {
    const { rows } = result;
    const shown = rows.length >= 10 ? rows : [...rows, ...blankRows(10 - rows.length)];
    return res.status(400).render('reports/attendees', {
      title: 'Attendance register', r, rows: shown, rowErrors: result.rowErrors, consent,
    });
  }
  const { added, linked } = result;
  req.flash('success', `${added} attendee${added === 1 ? '' : 's'} added${linked ? `, ${linked} already registered and linked` : ''}.`);
  return res.redirect(`/reports/${r.id}`);
});

router.get('/:id/edit', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  return res.render('reports/form', { title: 'Edit report', values: r, errors: {}, isNew: false, ...(await formLists(req.db)) });
});

router.post('/:id', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const v = svc.readReport(req.body);
  const errors = await svc.validateReport(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('reports/form', { title: 'Edit report', values: { ...r, ...v }, errors, isNew: false, ...(await formLists(req.db)) });
  }
  await svc.updateReport(req, r, v, { ifMatch: req.body._etag, attachments: await saveUploads(req.files, req.user) });
  req.flash('success', 'Report updated.');
  return res.redirect(`/reports/${r.id}`);
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  await svc.deleteReport(req, r);
  req.flash('success', 'Report deleted.');
  return res.redirect('/reports');
});

module.exports = router;
