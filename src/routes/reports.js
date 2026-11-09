'use strict';
const express = require('express');
const choices = require('../choices');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const svc = require('../services/reports');
const workplans = require('../services/workplans');
const logframes = require('../services/logframes');
const rich = require('../richtext');
const { saveUploads } = require('../services/attachments');
const {
  mapByIds, pagination, toCsv, sendCsv, fullName, tally, today,
} = require('../helpers');

const router = express.Router();

async function formLists(db, values = {}, user = null) {
  const [attendees, users, projects, partners, workplanOptions] = await Promise.all([
    db.find('people', { where: { kind: 'attendee' }, fields: ['id', 'firstName', 'lastName', 'activity'], orderBy: ['lastName', 'ASC'] }),
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] }),
    db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] }),
    db.find('stakeholders', { fields: ['id', 'name'], orderBy: ['name', 'ASC'] }),
    workplans.activityOptions(db, values),
  ]);
  const admin = Boolean(user && user.role === 'admin');
  // Staff only see the work plan activities of their own office (and of plans with no office).
  const mine = admin ? workplanOptions : workplanOptions.filter((o) => !o.plan.office || (user && o.plan.office === user.office)
    || (values.workplanId === o.plan.id && values.workplanItemId === o.item.id));
  return {
    attendees, users, projects, partners, workplanOptions: mine, richEditor: true, officeLocked: !admin,
  };
}

/** Sends the person back with the reason when they may not write for this office. */
function refused(req, res, e, to) {
  if (e.status !== 403) throw e;
  req.flash('danger', e.message);
  res.redirect(to);
  return null;
}

/** The form's work plan choice is one value, "planId:itemId". */
const withLink = (v) => ({ ...v, workplanItem: v.workplanId ? `${v.workplanId}:${v.workplanItemId || ''}` : '' });

/** "Write report" on a work plan: start the report from the planned activity. */
async function fromPlannedActivity(db, link) {
  const [planId, itemId] = String(link || '').split(':');
  const plan = planId ? await db.get('workplans', planId.slice(0, 60)) : null;
  const item = plan && (plan.items || []).find((it) => it.id === itemId);
  if (!item) return {};
  return {
    workplanId: plan.id,
    workplanItemId: item.id,
    heading: item.title,
    activityNumber: Number.isInteger(item.number) ? item.number : null,
    activityType: item.activityType || '',
    district: item.district || '',
    location: item.venue || '',
    projectId: plan.projectId || '',
  };
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
  const orgs = await mapByIds(req.db, 'stakeholders', reports.flatMap((r) => r.partnerIds || []));
  const byCat = (r, cat) => (r.attendeeIds || []).filter((id) => att[id] && att[id].ageCategory === cat).length;
  const disabled = (r) => (r.attendeeIds || []).filter((id) => att[id] && att[id].disability === 'Disabled').length;
  const csv = toCsv([
    { label: 'Date', value: 'date' },
    { label: 'Activity number', value: 'activityNumber' },
    { label: 'Type of activity', value: 'activityType' },
    { label: 'Heading', value: 'heading' },
    { label: 'Office', value: 'office' },
    { label: 'District', value: 'district' },
    { label: 'Venue', value: 'location' },
    { label: 'Partner organisations', value: (r) => (r.partnerIds || []).map((id) => orgs[id] && orgs[id].name).filter(Boolean) },
    { label: 'Registered attendees', value: (r) => (r.attendeeIds || []).length },
    ...choices.ageCategories.map((cat) => ({ label: `Attendees: ${cat}`, value: (r) => byCat(r, cat) })),
    { label: 'Attendees with a disability', value: disabled },
    { label: 'Other participants (unregistered)', value: 'otherParticipants' },
    { label: 'Immediate results', value: (r) => rich.toText(r.immediateResults) },
    { label: 'Compiled by', value: (r) => (users[r.compiledById] ? users[r.compiledById].fullName || users[r.compiledById].username : '') },
  ], reports);
  audit(req, 'export', 'reports', null, `Exported ${reports.length} reports to CSV`);
  sendCsv(res, `activity-reports-${today()}.csv`, csv);
});

router.get('/new', async (req, res) => {
  const values = {
    date: today(), compiledById: req.user.id, attendeeIds: [], ...(await fromPlannedActivity(req.db, req.query.workplanItem)),
  };
  try {
    await svc.settleOffice(req, values);
  } catch (e) {
    return refused(req, res, e, values.workplanId ? `/workplans/${values.workplanId}` : '/reports');
  }
  return res.render('reports/form', {
    title: 'New activity report', values: withLink(values), errors: {}, isNew: true, ...(await formLists(req.db, values, req.user)),
  });
});

router.post('/', async (req, res) => {
  const v = svc.readReport(req.body);
  try {
    await svc.settleOffice(req, v);
  } catch (e) {
    return refused(req, res, e, '/reports');
  }
  const errors = await svc.validateReport(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('reports/form', {
      title: 'New activity report', values: withLink(v), errors, isNew: true, ...(await formLists(req.db, v, req.user)),
    });
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
  const partners = Object.values(await mapByIds(req.db, 'stakeholders', r.partnerIds || [])).sort((a, b) => a.name.localeCompare(b.name));
  const plan = r.workplanId ? await req.db.get('workplans', r.workplanId) : null;
  const planned = plan ? (plan.items || []).find((it) => it.id === r.workplanItemId) : null;
  const lfLink = planned && planned.logframeId
    ? (await logframes.linkLabels(req.db, [planned]))[`${planned.logframeId}:${planned.logframeResultId}`] || null
    : null;
  const office = await svc.officeOf(req.db, r);
  return res.render('reports/show', {
    title: r.heading, r, attendees, users, project, partners, plan: planned ? plan : null, planned, lfLink, office, canWrite: svc.canWriteFor(req.user, office),
    byCategory: tally(attendees, 'ageCategory', choices.ageCategories),
    disabledCount: attendees.filter((a) => a.disability === 'Disabled').length,
  });
});

// Attendance register: add many attendees at once and link them to this report.
const blankRows = (n) => Array.from({ length: n }, () => ({}));

router.get('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  try { svc.mustWriteFor(req.user, await svc.officeOf(req.db, r)); } catch (e) { return refused(req, res, e, `/reports/${r.id}`); }
  res.render('reports/attendees', { title: 'Attendance register', r, rows: blankRows(10), rowErrors: {}, consent: {} });
});

router.post('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const raw = req.body.rows ? Object.values(req.body.rows) : [];
  const consent = { consentRecord: req.body.consentRecord, consentShare: req.body.consentShare };
  let result;
  try { result = await svc.addAttendees(req, r, raw, consent); } catch (e) { return refused(req, res, e, `/reports/${r.id}`); }
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
  const values = { ...r };
  try { await svc.settleOffice(req, values, r); } catch (e) { return refused(req, res, e, `/reports/${r.id}`); }
  return res.render('reports/form', {
    title: 'Edit report', values: withLink(values), errors: {}, isNew: false, ...(await formLists(req.db, values, req.user)),
  });
});

router.post('/:id', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const v = svc.readReport(req.body);
  try { await svc.settleOffice(req, v, r); } catch (e) { return refused(req, res, e, `/reports/${r.id}`); }
  const errors = await svc.validateReport(req.db, v);
  if (Object.keys(errors).length) {
    const values = { ...r, ...v };
    return res.status(400).render('reports/form', {
      title: 'Edit report', values: withLink(values), errors, isNew: false, ...(await formLists(req.db, values, req.user)),
    });
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
