'use strict';
const express = require('express');
const choices = require('../choices');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const svc = require('../services/reports');
const workplans = require('../services/workplans');
const logframes = require('../services/logframes');
const { HttpError } = require('../services/errors');
const rich = require('../richtext');
const { saveUploads } = require('../services/attachments');
const {
  mapByIds, pagination, toCsv, sendCsv, fullName, tally, today,
} = require('../helpers');

const router = express.Router();

async function formLists(db, values = {}, user = null) {
  const [attendees, users, projects, partners, workplanOptions] = await Promise.all([
    db.find('people', { where: { kind: 'attendee' }, fields: ['id', 'firstName', 'lastName', 'activity'], orderBy: ['lastName', 'ASC'] }),
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username', 'role'], orderBy: ['username', 'ASC'] }).then((us) => us.filter((u) => u.role !== 'viewer')),
    db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] }),
    db.find('stakeholders', { fields: ['id', 'name'], orderBy: ['name', 'ASC'] }),
    workplans.activityOptions(db, values),
  ]);
  const admin = svc.allOffices(user);
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
    { label: 'Contribution to the logframe', value: (r) => rich.toText(r.contribution) },
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

// ---------- Attendance: correct, add the signed registers, submit; administrators approve ----------
const attendance = require('../services/attendance');
const attStatus = require('../attendance-status');

router.get('/:id/attendance', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const office = await svc.officeOf(req.db, r);
  const data = await attendance.forReport(req.db, r);
  const users = await mapByIds(req.db, 'users', [r.attendanceSubmittedBy, r.attendanceDecidedBy, ...(r.attachments || []).map((a) => a.uploadedBy)].filter(Boolean));
  res.render('reports/attendance', {
    title: `Attendance: ${r.heading}`, r, data, users, status: attStatus.statusOf(r), LABEL: attStatus.LABEL,
    canWrite: svc.canWriteFor(req.user, office), registers: attendance.registerFiles(r), office,
  });
});

async function attendanceAction(req, res, fn) {
  const r = await svc.getReport(req.db, req.params.id);
  try {
    req.flash('success', await fn(r));
  } catch (e) {
    if (![403, 409, 412, 422].includes(e.status) && e.code !== 412) throw e;
    req.flash('danger', e.code === 412 ? 'Someone else changed this report meanwhile. Check the list and save again.' : e.message);
  }
  res.redirect(`/reports/${r.id}/attendance`);
}

router.post('/:id/indicators', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  try {
    await svc.saveIndicatorValues(req, r, req.body);
    req.flash('success', 'Indicator results saved. They count in the logframe once the report is submitted.');
  } catch (e) {
    if (!(e instanceof HttpError) || ![403, 422].includes(e.status)) throw e;
    req.flash('danger', e.message);
  }
  return res.redirect(`/reports/${r.id}#indicators`);
});

router.post('/:id/attendance', (req, res) => attendanceAction(req, res, async (r) => {
  const saved = await attendance.setAttended(req, r, req.body.attended || []);
  return `Attendance saved: ${saved.attendeeIds.length} attended.${saved.skipped ? ` ${saved.skipped} not recorded, because they are already on another register of this planned activity.` : ''}`;
}));
router.post('/:id/attendance/registers', (req, res) => attendanceAction(req, res, async (r) => {
  const files = await saveUploads(req.files, req.user);
  await attendance.addRegisterFiles(req, r, files);
  return `${files.length} signed register file${files.length === 1 ? '' : 's'} added.`;
}));
router.post('/:id/attendance/submit', (req, res) => attendanceAction(req, res, async (r) => {
  await attendance.submit(req, r);
  return 'Attendance submitted. An administrator will check it against the signed registers.';
}));
router.post('/:id/attendance/decide', (req, res) => attendanceAction(req, res, async (r) => {
  const saved = await attendance.decide(req, r, req.body.decision, req.body.note, req.body.verified || []);
  if (saved.attendanceStatus !== 'Approved') return 'Attendance returned for correction.';
  const n = saved.attendeeIds.length;
  return `${req.body.decision === 'verify' ? 'Verification saved' : 'Attendance approved'}: ${n} ${n === 1 ? 'person' : 'people'} verified${saved.dropped ? `, ${saved.dropped} ticked by the office not confirmed and left off the register` : ''}. Only verified people count.`;
}));

// ---------- Payment acquittal: transport, incidental and accommodation for eligible attendees ----------
const acquittal = require('../services/acquittal');

async function acquittalData(req, r) {
  const { acq, fromPlan } = await acquittal.forReport(req.db, r);
  const { rows } = await attendance.forReport(req.db, r);
  const byId = Object.fromEntries(rows.map((x) => [x.person.id, x]));
  // Only people still on this report's attendance count; the plan's acquittal may name people who did not come.
  const t = acquittal.totals({ ...acq, rows: acq.rows.filter((x) => byId[x.personId] && !byId[x.personId].elsewhere) });
  return {
    acq, rows, byId, t, fromPlan,
  };
}
const reportInfo = (r) => ({
  title: r.heading, type: r.activityType, date: r.date, venue: r.location, district: r.district, ref: `Activity report of ${r.date ? require('../helpers').fmtDate(r.date) : ''}`,
});

router.get('/:id/payments', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const {
    acq, rows, t, fromPlan,
  } = await acquittalData(req, r);
  const inList = Object.fromEntries(acq.rows.map((x) => [x.personId, x]));
  const staff = (await req.db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username', 'role'], orderBy: ['username', 'ASC'] })).filter((u) => u.role !== 'viewer');
  res.render('reports/payments', {
    title: `Payment acquittal: ${r.heading}`, acq, rows, inList, t, fromPlan, CURRENCIES: acquittal.CURRENCIES, staff, defaultResponsible: r.compiledById,
    canEdit: await acquittal.canEdit(req, r), info: reportInfo(r),
    urls: {
      crumbs: [{ href: '/reports', label: 'Activity reports' }, { href: `/reports/${r.id}`, label: r.heading }],
      action: `/reports/${r.id}/payments`, print: `/reports/${r.id}/payments/print`, people: { href: `/reports/${r.id}/attendance`, label: 'Attendance' },
    },
    lockedText: 'You can view this acquittal. Staff of the activity\'s office prepare it; once the attendance is approved, only an administrator can change it.',
    peopleNote: 'The list holds the people invited to or recorded at this activity; add walk-ins on the attendance page first.',
    emptyText: 'Nobody is invited or recorded for this activity yet.',
  });
});

router.post('/:id/payments', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  try {
    const saved = await acquittal.save(req, r, req.body);
    const t = acquittal.totals(acquittal.of(saved));
    req.flash('success', `Payment acquittal saved: ${t.people} ${t.people === 1 ? 'person' : 'people'}, ${acquittal.of(saved).currency} ${t.sums.total.toLocaleString('en-GB', { minimumFractionDigits: 2 })}${acquittal.activityNote(acquittal.of(saved))}.`);
  } catch (e) {
    if (![403, 422].includes(e.status)) throw e;
    req.flash('danger', e.message);
  }
  res.redirect(`/reports/${r.id}/payments`);
});

router.get('/:id/payments/print', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const { acq, byId, t } = await acquittalData(req, r);
  const lines = t.lines.filter((l) => l.total > 0 && byId[l.personId])
    .map((l) => ({ ...l, person: byId[l.personId].person }))
    .sort((x, y) => `${x.person.lastName} ${x.person.firstName}`.localeCompare(`${y.person.lastName} ${y.person.firstName}`));
  const project = r.projectId ? await req.db.get('projects', r.projectId) : null;
  const users = await mapByIds(req.db, 'users', [acq.preparedBy, r.compiledById].filter(Boolean));
  res.render('reports/acquittal-print', {
    title: `Payment acquittal: ${r.heading}`, acq, lines, sums: t.sums, project, users, office: await svc.officeOf(req.db, r),
    info: reportInfo(r), urls: { back: `/reports/${r.id}/payments` },
  });
});

/** An attendance register for signing at this activity; it can list the people already registered. */
router.get('/:id/register', async (req, res) => {
  const reg = require('../registers');
  const r = await svc.getReport(req.db, req.params.id);
  // The invite list and the people already recorded print first, by village or area; blank lines follow.
  const rows = (await require('../services/attendance').forReport(req.db, r)).rows.filter((x) => !x.elsewhere);
  const withNames = rows.length > 0 && (req.query.names === undefined || [].concat(req.query.names).includes('1'));
  const people = withNames ? rows.map((x) => x.person) : [];
  const project = r.projectId ? await req.db.get('projects', r.projectId) : null;
  const who = r.compiledById ? await req.db.get('users', r.compiledById) : null;
  res.render('register', {
    title: `Register: ${r.heading}`,
    info: {
      title: r.heading, type: r.activityType || '', date: r.date || '', venue: r.location || '', district: r.district || '',
      office: await svc.officeOf(req.db, r), project: project ? project.title : '', donor: project ? project.donor || '' : '', plan: '',
      facilitator: who ? who.fullName || who.username : '', ref: `Activity report of ${r.date || ''}`,
    },
    sheets: reg.pages(reg.lineCount(req.query.rows, { people: (r.attendeeIds || []).length + (r.otherParticipants || 0) }), people),
    canName: rows.length > 0, withNames, namesLabel: `Print the ${rows.length} invited or recorded people`,
    back: { href: `/reports/${r.id}`, label: r.heading },
  });
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
  await require('../services/comments').attach(req, res, 'reports', r.id);
  const indicators = await logframes.reportIndicators(req.db, r);
  return res.render('reports/show', {
    title: r.heading, r, attendees, users, project, partners, plan: planned ? plan : null, planned, lfLink, office, canWrite: svc.canWriteFor(req.user, office), indicators: indicators.list,
    attStatus: require('../attendance-status').statusOf(r), attLabel: require('../attendance-status').LABEL[require('../attendance-status').statusOf(r)],
    byCategory: tally(attendees, 'ageCategory', choices.ageCategories),
    disabledCount: attendees.filter((a) => a.disability === 'Disabled').length,
  });
});

// Attendance register: add many attendees at once and link them to this report.
const blankRows = (n) => Array.from({ length: n }, () => ({}));

router.get('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  if (attStatus.locked(r)) {
    req.flash('danger', `This attendance is ${attStatus.LABEL[attStatus.statusOf(r)].toLowerCase()}, so people cannot be added. An administrator can return it for correction.`);
    return res.redirect(`/reports/${r.id}/attendance`);
  }
  try { svc.mustWriteFor(req.user, await svc.officeOf(req.db, r)); } catch (e) { return refused(req, res, e, `/reports/${r.id}`); }
  res.render('reports/attendees', { title: 'Attendance register', r, rows: blankRows(10), rowErrors: {}, consent: {} });
});

router.post('/:id/attendees', async (req, res) => {
  const r = await svc.getReport(req.db, req.params.id);
  const raw = req.body.rows ? Object.values(req.body.rows) : [];
  const consent = { consentRecord: req.body.consentRecord, consentShare: req.body.consentShare };
  let result;
  try { result = await svc.addAttendees(req, r, raw, consent); } catch (e) {
    if (e.status === 409) { req.flash('danger', e.message); return res.redirect(`/reports/${r.id}/attendance`); }
    return refused(req, res, e, `/reports/${r.id}`);
  }
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
  const { added, linked, skipped = [] } = result;
  req.flash('success', `${added} attendee${added === 1 ? '' : 's'} added${linked ? `, ${linked} already registered and linked` : ''}.`);
  if (skipped.length) req.flash('warning', `Not added, because they are already on another register of this planned activity: ${skipped.join(', ')}. A person is recorded once per planned activity.`);
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
  const errors = await svc.validateReport(req.db, v, r.id);
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
