'use strict';
const express = require('express');
const { audit } = require('../audit');
const { isAdmin } = require('../access');
const svc = require('../services/workplans');
const logframes = require('../services/logframes');
const { notFound } = require('../services/errors');
const {
  mapByIds, toCsv, sendCsv, today, str,
} = require('../helpers');

const router = express.Router();

async function lists(db) {
  const [users, projects] = await Promise.all([
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username', 'role'], orderBy: ['username', 'ASC'] }).then((us) => us.filter((u) => u.role !== 'viewer')),
    db.find('projects', { fields: ['id', 'title', 'currency'], orderBy: ['title', 'ASC'] }),
  ]);
  return { users, projects };
}

/**
 * Errors thrown by the rules (permission or a refused status change) become a message on the plan page.
 * With `showForm`, a field problem found while saving (for example a colleague took the activity number
 * a moment earlier) shows the form again with the typed values instead.
 */
async function friendly(req, res, planId, step, showForm = null) {
  try {
    return await step();
  } catch (e) {
    if (showForm && e.status === 422 && e.fields) {
      await showForm(e.fields);
      return null;
    }
    if (![403, 404, 422].includes(e.status)) throw e;
    req.flash(e.status === 422 ? 'warning' : 'danger', e.message);
    res.redirect(planId ? `/workplans/${planId}` : '/workplans');
    return null;
  }
}

// ---------- List ----------
router.get('/', async (req, res) => {
  const plans = await req.db.find('workplans', { ...svc.planQuery(req.query), orderBy: ['periodStart', 'DESC'] });
  const summaries = await svc.totalsFor(req.db, plans);
  const projects = await mapByIds(req.db, 'projects', plans.map((p) => p.projectId));
  const allProjects = await req.db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] });
  res.render('workplans/list', {
    title: 'Work plans', plans, summaries, projects, allProjects, wp: svc.view,
  });
});

// ---------- Combined work plan (all offices) ----------
function combinedQuery(q) {
  const y = today().slice(0, 4);
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
  let from = ok(q.from) ? q.from : `${y}-01-01`;
  let to = ok(q.to) ? q.to : `${y}-12-31`;
  if (from > to) [from, to] = [to, from];
  return { from, to, projectId: str(q.projectId, 60), includeDrafts: q.drafts === '1', showBudget: q.budget === '1' };
}

router.get('/combined', async (req, res) => {
  const opts = combinedQuery(req.query);
  const data = await svc.combined(req.db, opts);
  const lfLabels = await logframes.linkLabels(req.db, data.groups.flatMap((g) => g.rows.map((r) => r.item)));
  const allProjects = await req.db.find('projects', { fields: ['id', 'title', 'donor'], orderBy: ['title', 'ASC'] });
  const project = opts.projectId ? allProjects.find((p) => p.id === opts.projectId) : null;
  res.render('workplans/combined', {
    title: 'Combined work plan', opts, data, lfLabels, allProjects, project, t0: today(), wp: svc.view, printLandscape: true,
  });
});

router.get('/combined.csv', async (req, res) => {
  const opts = combinedQuery(req.query);
  const data = await svc.combined(req.db, opts);
  const lfLabels = await logframes.linkLabels(req.db, data.groups.flatMap((g) => g.rows.map((r) => r.item)));
  const who = (id) => (data.users[id] ? data.users[id].fullName || data.users[id].username : '');
  const rows = data.groups.flatMap((g) => g.rows.map((r) => ({ ...r, office: g.office })));
  const csv = toCsv([
    { label: 'Office', value: 'office' },
    { label: 'Work plan', value: (r) => r.plan.title },
    { label: 'Project', value: (r) => (data.projects[r.plan.projectId] ? data.projects[r.plan.projectId].title : '') },
    { label: 'Activity number', value: (r) => r.item.number },
    { label: 'Activity', value: (r) => r.item.title },
    { label: 'Logframe', value: (r) => { const l = lfLabels[`${r.item.logframeId}:${r.item.logframeResultId}`]; return l ? `${l.label}: ${l.text}` : ''; } },
    { label: 'Type of activity', value: (r) => r.item.activityType },
    { label: 'Venue', value: (r) => r.item.venue },
    { label: 'District', value: (r) => r.item.district },
    { label: 'Responsible', value: (r) => who(r.item.responsibleId) },
    { label: 'Start', value: (r) => r.item.startDate },
    { label: 'End', value: (r) => r.item.endDate },
    { label: 'Planned number of times', value: (r) => r.item.targetEvents },
    { label: 'People to reach', value: (r) => r.item.targetPeople },
    // The budget columns are left out unless the internal version is asked for
    ...(opts.showBudget ? [{ label: 'Currency', value: 'currency' }, { label: 'Budget', value: (r) => r.item.budget }] : []),
    { label: 'Status', value: (r) => r.item.status },
  ], rows);
  return sendCsv(res, `combined-work-plan-${opts.from}-to-${opts.to}${opts.showBudget ? '-with-budget' : ''}.csv`, csv);
});

// ---------- New plan ----------
router.get('/new', async (req, res) => {
  const y = today().slice(0, 4);
  const values = {
    periodStart: `${y}-01-01`, periodEnd: `${y}-12-31`, preparedById: req.user.id, currency: 'ZMW', office: req.user.office || '',
  };
  res.render('workplans/form', {
    title: 'New work plan', values, errors: {}, isNew: true, ...(await lists(req.db)),
  });
});

router.post('/', async (req, res) => {
  const v = svc.readPlan(req.body);
  const errors = await svc.validatePlan(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('workplans/form', {
      title: 'New work plan', values: v, errors, isNew: true, ...(await lists(req.db)),
    });
  }
  const doc = await svc.createPlan(req, v);
  const fromLogframe = v.projectId && await logframes.getFramework(req.db, v.projectId);
  req.flash('success', fromLogframe
    ? 'Work plan created. Now add its activities from the project logframe.'
    : 'Work plan created. Now add the planned activities.');
  return res.redirect(fromLogframe ? `/workplans/${doc.id}/from-logframe` : `/workplans/${doc.id}`);
});

/** Is there a logframe this plan can draw its activities from? */
async function canDraw(db, plan) {
  if (plan.projectId) return Boolean(await logframes.getFramework(db, plan.projectId));
  return (await db.count('logframes', {})) > 0;
}

// ---------- One plan ----------
router.get('/:id', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const { items, totals } = await svc.progress(req.db, plan);
  const users = await svc.planUsers(req.db, plan);
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const lfLabels = await logframes.linkLabels(req.db, plan.items);
  const draw = svc.canEdit(req.user, plan) && await canDraw(req.db, plan);
  const lfRequired = await svc.requiredFramework(req.db, plan);
  const offPlan = svc.notFromLogframe(plan, lfRequired);
  await require('../services/comments').attach(req, res, 'workplans', plan.id);
  res.render('workplans/show', {
    title: plan.title, plan, items, totals, users, project, lfLabels, draw, lfRequired: Boolean(lfRequired), offPlan: new Set(offPlan.map((it) => it.id)),
    canEdit: svc.canEdit(req.user, plan), canProgress: svc.canUpdateProgress(req.user, plan), admin: isAdmin(req.user), t0: today(), wp: svc.view,
    canReport: require('../services/reports').canWriteFor(req.user, plan.office),
  });
});

// ---------- Shortlist of invited attendees for a planned activity ----------
const attendance = require('../services/attendance');

async function loadItem(req) {
  const plan = await svc.getPlan(req.db, req.params.id);
  const item = (plan.items || []).find((x) => x.id === req.params.itemId);
  if (!item) throw notFound('Planned activity');
  return { plan, item };
}

router.get('/:id/activities/:itemId/shortlist', async (req, res) => {
  const { plan, item } = await loadItem(req);
  const [people, areas, found] = await Promise.all([
    attendance.shortlistPeople(req.db, item, plan), attendance.areas(req.db), attendance.search(req.db, req.query.q),
  ]);
  const done = await attendance.attendedActivity(req.db, plan, item);
  let canChange = true;
  try { attendance.mustShortlist(req.user, plan); } catch { canChange = false; }
  const inList = new Set(item.shortlist || []);
  res.render('workplans/shortlist', {
    title: `Invite list: ${item.title}`, plan, item, people, areas, confirmed: attendance.confirmCounts(item), q: String(req.query.q || '').slice(0, 60), canChange,
    found: found.filter((p) => !inList.has(p.id)).map((p) => ({ ...p, attended: done.get(p.id) || null })),
  });
});

async function shortlistAction(req, res, fn) {
  const { plan, item } = await loadItem(req);
  const back = `/workplans/${plan.id}/activities/${item.id}/shortlist`;
  try {
    const msg = await fn(plan, item);
    req.flash('success', msg);
  } catch (e) {
    if (![403, 409, 422].includes(e.status)) throw e;
    req.flash('danger', e.message);
  }
  res.redirect(back);
}

router.post('/:id/activities/:itemId/shortlist/import', (req, res) => shortlistAction(req, res, async (plan, item) => {
  const r = await attendance.importAreas(req, plan, item.id, req.body.areas || []);
  const areasN = [].concat(req.body.areas || []).length;
  return `${r.added} attendee${r.added === 1 ? '' : 's'} added to the invite list. ${r.found} ${r.found === 1 ? 'is' : 'are'} registered in the chosen area${areasN === 1 ? '' : 's'}`
    + `${r.already ? `; ${r.already} already attended a session of this activity and ${r.already === 1 ? 'was' : 'were'} not invited again` : ''}; the others were already on the list.`;
}));
router.post('/:id/activities/:itemId/shortlist/add', (req, res) => shortlistAction(req, res, async (plan, item) => {
  await attendance.addPeople(req, plan, item.id, req.body.personIds || []);
  return 'Added to the invite list.';
}));
router.post('/:id/activities/:itemId/shortlist/confirm', (req, res) => shortlistAction(req, res, async (plan, item) => {
  const answer = String(req.body.answer || '');
  const n = await attendance.confirm(req, plan, item.id, req.body.personIds || [], answer);
  const what = { yes: 'confirmed as coming', no: 'marked as not coming' }[answer] || 'marked as not yet confirmed';
  return `${n} ${n === 1 ? 'person' : 'people'} ${what}.`;
}));
router.post('/:id/activities/:itemId/shortlist/remove', (req, res) => shortlistAction(req, res, async (plan, item) => {
  const n = [].concat(req.body.personIds || []).length;
  if (!n) throw Object.assign(new Error('Tick the people to remove first.'), { status: 422 });
  await attendance.removePeople(req, plan, item.id, req.body.personIds);
  return `${n} removed from the invite list.`;
}));

// ---------- Payment acquittal prepared before the activity, for the people on the invite list ----------
const acquittal = require('../services/acquittal');

async function itemPayments(req) {
  const { plan, item } = await loadItem(req);
  const rows = await acquittal.itemPeople(req.db, plan, item);
  const acq = acquittal.of(item);
  const ok = new Set(rows.filter((x) => !x.elsewhere).map((x) => x.person.id));
  const t = acquittal.totals({ ...acq, rows: acq.rows.filter((x) => ok.has(x.personId)) });
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const info = {
    title: item.title, type: item.activityType, date: item.startDate && item.startDate === item.endDate ? item.startDate : '', venue: item.venue, district: item.district,
    ref: `Work plan activity ${Number.isInteger(item.number) ? `${item.number} ` : ''}${plan.title}`,
  };
  return {
    plan, item, rows, acq, t, project, info,
  };
}

router.get('/:id/activities/:itemId/payments', async (req, res) => {
  const {
    plan, item, rows, acq, t, info,
  } = await itemPayments(req);
  let canChange = true;
  try { attendance.mustShortlist(req.user, plan); } catch { canChange = false; }
  const base = `/workplans/${plan.id}/activities/${item.id}`;
  const staff = (await req.db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username', 'role'], orderBy: ['username', 'ASC'] })).filter((u) => u.role !== 'viewer');
  res.render('reports/payments', {
    title: `Payment acquittal: ${item.title}`, acq, rows, t, inList: Object.fromEntries(acq.rows.map((x) => [x.personId, x])), staff, defaultResponsible: item.responsibleId,
    CURRENCIES: acquittal.CURRENCIES, canEdit: canChange, info,
    urls: {
      crumbs: [{ href: '/workplans', label: 'Work plans' }, { href: `/workplans/${plan.id}#act-${item.id}`, label: plan.title }],
      action: `${base}/payments`, print: `${base}/payments/print`, people: { href: `${base}/shortlist`, label: 'Invite list' },
    },
    lockedText: `You can view this acquittal. Staff of ${plan.office || 'the plan\'s office'} prepare it while the plan is open.`,
    peopleNote: 'Prepared before the activity for the people on the invite list. When the activity report is written, its payment acquittal starts from this one; tick there who was actually paid.',
    emptyText: 'Nobody is on the invite list yet.',
  });
});

router.post('/:id/activities/:itemId/payments', async (req, res) => {
  const { plan, item } = await loadItem(req);
  try {
    const { acq, t } = await acquittal.saveForItem(req, plan, item.id, req.body);
    req.flash('success', `Payment acquittal saved: ${t.people} ${t.people === 1 ? 'person' : 'people'}, ${acq.currency} ${t.sums.total.toLocaleString('en-GB', { minimumFractionDigits: 2 })}${acquittal.activityNote(acquittal.of({ acquittal: acq }))}.`);
  } catch (e) {
    if (![403, 409, 422].includes(e.status)) throw e;
    req.flash('danger', e.message);
  }
  res.redirect(`/workplans/${plan.id}/activities/${item.id}/payments`);
});

router.get('/:id/activities/:itemId/payments/print', async (req, res) => {
  const {
    plan, item, rows, acq, t, project, info,
  } = await itemPayments(req);
  const byId = Object.fromEntries(rows.map((x) => [x.person.id, x]));
  const lines = t.lines.filter((l) => l.total > 0 && byId[l.personId]).map((l) => ({ ...l, person: byId[l.personId].person }))
    .sort((x, y) => `${x.person.lastName} ${x.person.firstName}`.localeCompare(`${y.person.lastName} ${y.person.firstName}`));
  res.render('reports/acquittal-print', {
    title: `Payment acquittal: ${item.title}`, acq, lines, sums: t.sums, project, users: await mapByIds(req.db, 'users', [acq.preparedBy].filter(Boolean)),
    office: plan.office || '', info, urls: { back: `/workplans/${plan.id}/activities/${item.id}/payments` },
  });
});

/** A blank attendance register for signing at a planned activity, printed before the meeting. */
router.get('/:id/activities/:itemId/register', async (req, res) => {
  const reg = require('../registers');
  const plan = await svc.getPlan(req.db, req.params.id);
  const it = (plan.items || []).find((x) => x.id === req.params.itemId);
  if (!it) throw notFound('Planned activity');
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const who = it.responsibleId ? await req.db.get('users', it.responsibleId) : null;
  const num = Number.isInteger(it.number) ? `${it.number}. ` : '';
  // The invite list prints first, by village or area; blank lines follow for walk-ins.
  // People already recorded at a session of this activity are left off: they are recorded once per activity.
  const invited = (await require('../services/attendance').shortlistPeople(req.db, it, plan)).filter((p) => !p.attended);
  const withNames = invited.length > 0 && (req.query.names === undefined || [].concat(req.query.names).includes('1'));
  const code = reg.planCode(plan, it);
  res.render('register', {
    title: `${code} Attendance register ${it.title}`,
    info: {
      code,
      title: it.title, type: it.activityType || '', date: it.startDate && it.startDate === it.endDate ? it.startDate : '',
      venue: it.venue || '', district: it.district || '', office: plan.office || '', project: project ? project.title : '', donor: project ? project.donor || '' : '',
      plan: `${num}${plan.title}`, facilitator: who ? who.fullName || who.username : '', ref: `Work plan activity ${num.trim()} ${plan.title}`.trim(),
    },
    sheets: reg.pages(reg.lineCount(req.query.rows, { people: it.targetPeople, times: it.targetEvents }), withNames ? invited : []),
    canName: invited.length > 0, withNames, namesLabel: `Print the ${invited.length} people on the invite list`,
    back: { href: `/workplans/${plan.id}#act-${it.id}`, label: plan.title },
  });
});

/** The whole plan on landscape A4, with signature lines, to print or save as PDF. */
router.get('/:id/print', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const { items, totals } = await svc.progress(req.db, plan);
  const users = await svc.planUsers(req.db, plan);
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const lfLabels = await logframes.linkLabels(req.db, plan.items);
  res.render('workplans/print', {
    title: `${plan.title} (print)`, plan, items, totals, users, project, lfLabels, t0: today(), wp: svc.view, printLandscape: true, showBudget: req.query.budget !== '0',
  });
});

router.get('/:id/export.csv', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const { items } = await svc.progress(req.db, plan);
  const users = await svc.planUsers(req.db, plan);
  const lfLabels = await logframes.linkLabels(req.db, plan.items);
  const who = (id) => (users[id] ? users[id].fullName || users[id].username : '');
  const lfOf = (it) => {
    const l = lfLabels[`${it.logframeId}:${it.logframeResultId}`];
    return l ? `${l.label}: ${l.text}` : '';
  };
  const csv = toCsv([
    { label: 'Activity number', value: 'number' },
    { label: 'Activity', value: 'title' },
    { label: 'Type of activity', value: 'activityType' },
    { label: 'District', value: 'district' },
    { label: 'Venue', value: 'venue' },
    { label: 'Responsible', value: (it) => who(it.responsibleId) },
    { label: 'Start', value: 'startDate' },
    { label: 'End', value: 'endDate' },
    { label: 'Expected output or indicator', value: 'output' },
    { label: 'Planned number of times', value: 'targetEvents' },
    { label: 'Delivered (activity reports)', value: 'delivered' },
    { label: 'People to reach', value: 'targetPeople' },
    { label: 'People reached', value: 'reached' },
    { label: `Budget (${plan.currency})`, value: 'budget' },
    { label: 'Status', value: 'status' },
    { label: 'Overdue', value: (it) => (it.overdue ? 'Yes' : '') },
    { label: 'Logframe', value: lfOf },
  ], items);
  audit(req, 'export', 'workplans', plan.id, `Exported work plan "${plan.title}" to CSV`);
  sendCsv(res, `work-plan-${plan.periodStart}-${plan.id.slice(0, 8)}.csv`, csv);
});

router.get('/:id/edit', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  if (!svc.canEdit(req.user, plan)) {
    req.flash('warning', 'This work plan is approved or closed, so only an administrator can change it.');
    return res.redirect(`/workplans/${plan.id}`);
  }
  return res.render('workplans/form', {
    title: `Edit ${plan.title}`, values: plan, errors: {}, isNew: false, ...(await lists(req.db)),
  });
});

router.post('/:id', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const v = svc.readPlan(req.body);
  const moveActivities = req.body.moveActivities === 'on';
  const again = async (errors) => res.status(400).render('workplans/form', {
    title: `Edit ${plan.title}`, values: { ...plan, ...v, moveActivities }, errors, isNew: false, ...(await lists(req.db)),
  });
  const errors = await svc.validatePlan(req.db, v, plan, { moveActivities });
  if (Object.keys(errors).length) return again(errors);
  const saved = await friendly(req, res, plan.id, () => svc.updatePlan(req, plan, v, { ifMatch: req.body._etag, moveActivities }), again);
  if (!saved) return undefined;
  const moved = moveActivities && v.periodStart !== plan.periodStart && (plan.items || []).length;
  req.flash('success', moved ? 'Work plan updated. The activity dates moved with the new period. Please check them below.' : 'Work plan updated.');
  return res.redirect(`/workplans/${plan.id}`);
});

const STATUS_WORDS = {
  Approved: 'approved', Draft: 'returned to draft', Closed: 'closed',
};
router.post('/:id/status', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const status = str(req.body.status);
  const saved = await friendly(req, res, plan.id, () => svc.setPlanStatus(req, plan, status));
  if (!saved) return undefined;
  req.flash('success', `Work plan ${STATUS_WORDS[status] || 'updated'}.`);
  return res.redirect(`/workplans/${plan.id}`);
});

router.post('/:id/copy', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const doc = await svc.copyPlan(req, plan);
  req.flash('success', 'Copy created as a new draft. Set its title and period, then adjust the activities.');
  res.redirect(`/workplans/${doc.id}/edit`);
});

router.post('/:id/delete', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const result = await friendly(req, res, plan.id, () => svc.deletePlan(req, plan));
  if (!result) return undefined;
  req.flash('success', `Work plan deleted.${result.unlinked ? ` ${result.unlinked} activity report${result.unlinked === 1 ? ' was' : 's were'} kept and unlinked.` : ''}`);
  return res.redirect('/workplans');
});

// ---------- Planned activities drawn from the logframe ----------
async function drawPage(req, res, plan, { rowValues = {}, rowErrors = {}, status = 200 } = {}) {
  const projectId = plan.projectId || str(req.query.project || req.body.project, 60);
  const fw = projectId ? await logframes.getFramework(req.db, projectId) : null;
  const { users } = await lists(req.db);
  if (!fw) {
    // A plan for no particular project: choose which project's logframe to draw from.
    const fws = await req.db.find('logframes', { fields: ['id', 'projectId'] });
    const projects = Object.values(await mapByIds(req.db, 'projects', fws.map((x) => x.projectId)));
    if (!projects.length) {
      req.flash('warning', 'There is no logframe to draw from yet. An administrator sets one up under M&E.');
      return res.redirect(`/workplans/${plan.id}`);
    }
    return res.status(status).render('workplans/from-logframe', {
      title: 'Add activities from the logframe', plan, fw: null, projects, rows: [], users, rowValues, rowErrors, project: null,
    });
  }
  const project = await req.db.get('projects', fw.projectId);
  return res.status(status).render('workplans/from-logframe', {
    title: 'Add activities from the logframe', plan, fw, project, projects: [], rows: logframes.plannable(fw, plan), users, rowValues, rowErrors,
  });
}

router.get('/:id/from-logframe', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  if (!svc.canEdit(req.user, plan)) {
    req.flash('warning', 'This work plan is approved or closed, so only an administrator can add activities.');
    return res.redirect(`/workplans/${plan.id}`);
  }
  return drawPage(req, res, plan);
});

router.post('/:id/from-logframe', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  if (!svc.canEdit(req.user, plan)) {
    req.flash('warning', 'This work plan is approved or closed, so only an administrator can add activities.');
    return res.redirect(`/workplans/${plan.id}`);
  }
  const projectId = plan.projectId || str(req.body.project, 60);
  const fw = await logframes.mustFramework(req.db, projectId);
  const raw = req.body.rows && typeof req.body.rows === 'object' ? req.body.rows : {};
  const picked = Object.entries(raw).filter(([, r]) => r && r.add === 'on');
  if (!picked.length) {
    req.flash('warning', 'Tick at least one activity to add.');
    return res.redirect(`/workplans/${plan.id}/from-logframe${plan.projectId ? '' : `?project=${encodeURIComponent(projectId)}`}`);
  }
  const rowErrors = {};
  const list = [];
  for (const [key, r] of picked) {
    const v = svc.readActivity({
      title: r.title, venue: r.venue, responsibleId: r.responsibleId, startDate: r.startDate, endDate: r.endDate, targetEvents: r.targetEvents,
      targetPeople: r.targetPeople, budget: r.budget, status: 'Not started', logframeId: fw.id, logframeResultId: str(r.resultId, 60),
    });
    const e = await svc.validateActivity(req.db, plan, v);
    if (Object.keys(e).length) rowErrors[key] = Object.values(e).join(' ');
    list.push(v);
  }
  if (Object.keys(rowErrors).length) return drawPage(req, res, plan, { rowValues: raw, rowErrors, status: 400 });
  const result = await friendly(req, res, plan.id, () => svc.addActivities(req, plan, list));
  if (!result) return undefined;
  req.flash('success', `${list.length} planned activit${list.length === 1 ? 'y' : 'ies'} added from the logframe, each linked to its logframe activity. Set their districts and types where needed.`);
  return res.redirect(`/workplans/${plan.id}`);
});

// ---------- Planned activities ----------
async function activityForm(req, res, plan, values, errors, isNew, status = 200) {
  const { users } = await lists(req.db);
  const lfRequired = Boolean(await svc.requiredFramework(req.db, plan));
  const lfGroups = await logframes.linkOptions(req.db, { projectId: plan.projectId, current: values, onlyPlannable: lfRequired });
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const logframeResult = values.logframeId ? `${values.logframeId}:${values.logframeResultId || ''}` : '';
  res.status(status).render('workplans/activity-form', {
    title: isNew ? 'Add planned activity' : 'Edit planned activity', plan, values: { ...values, logframeResult }, errors, isNew, users, lfGroups, lfRequired, project,
  });
}

router.get('/:id/activities/new', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  if (!svc.canEdit(req.user, plan)) return res.redirect(`/workplans/${plan.id}`);
  return activityForm(req, res, plan, {
    number: svc.nextNumber(plan), status: 'Not started', targetEvents: 1, startDate: plan.periodStart, endDate: plan.periodEnd,
  }, {}, true);
});

router.post('/:id/activities', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const v = svc.readActivity(req.body);
  const again = (errors) => activityForm(req, res, plan, v, errors, true, 400);
  const errors = await svc.validateActivity(req.db, plan, v);
  if (Object.keys(errors).length) return again(errors);
  // Adding never conflicts with a colleague's change, so it is saved onto the latest version of the plan.
  const result = await friendly(req, res, plan.id, () => svc.addActivity(req, plan, v), again);
  if (!result) return undefined;
  req.flash('success', `Activity ${result.item.number} added.`);
  if (req.body.next === 'another') return res.redirect(`/workplans/${plan.id}/activities/new`);
  return res.redirect(`/workplans/${plan.id}#act-${result.item.id}`);
});

router.get('/:id/activities/:itemId/edit', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const item = svc.getItem(plan, req.params.itemId);
  if (!svc.canEdit(req.user, plan)) return res.redirect(`/workplans/${plan.id}`);
  return activityForm(req, res, plan, item, {}, false);
});

router.post('/:id/activities/:itemId', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const item = svc.getItem(plan, req.params.itemId);
  const v = svc.readActivity(req.body);
  // Refused only if a colleague changed this activity since the form was opened, not another one.
  const version = str(req.body._version, 40) || item.updatedAt;
  const again = (errors) => activityForm(req, res, plan, { ...item, ...v, updatedAt: version }, errors, false, 400);
  const errors = await svc.validateActivity(req.db, plan, v, item.id);
  if (Object.keys(errors).length) return again(errors);
  const result = await friendly(req, res, plan.id, () => svc.updateActivity(req, plan, item.id, v, { version }), again);
  if (!result) return undefined;
  req.flash('success', `Activity ${result.item.number} updated.`);
  return res.redirect(`/workplans/${plan.id}#act-${item.id}`);
});

router.post('/:id/activities/:itemId/progress', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const result = await friendly(req, res, plan.id, () => svc.setActivityStatus(req, plan, req.params.itemId, str(req.body.status)));
  if (!result) return undefined;
  req.flash('success', `Activity ${result.item.number}: ${result.item.status}.`);
  return res.redirect(`/workplans/${plan.id}#act-${result.item.id}`);
});

router.post('/:id/activities/:itemId/delete', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  const result = await friendly(req, res, plan.id, () => svc.deleteActivity(req, plan, req.params.itemId));
  if (!result) return undefined;
  req.flash('success', `Activity removed.${result.unlinked ? ` ${result.unlinked} activity report${result.unlinked === 1 ? ' was' : 's were'} kept and unlinked.` : ''}`);
  return res.redirect(`/workplans/${plan.id}`);
});

module.exports = router;
