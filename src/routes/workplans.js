'use strict';
const express = require('express');
const { audit } = require('../audit');
const { isAdmin } = require('../access');
const svc = require('../services/workplans');
const logframes = require('../services/logframes');
const {
  mapByIds, toCsv, sendCsv, today, str,
} = require('../helpers');

const router = express.Router();

async function lists(db) {
  const [users, projects] = await Promise.all([
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] }),
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
  res.render('workplans/show', {
    title: plan.title, plan, items, totals, users, project, lfLabels, draw,
    canEdit: svc.canEdit(req.user, plan), canProgress: svc.canUpdateProgress(req.user, plan), admin: isAdmin(req.user), t0: today(), wp: svc.view,
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
      title: r.title, responsibleId: r.responsibleId, startDate: r.startDate, endDate: r.endDate, targetEvents: r.targetEvents,
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
  const lfGroups = await logframes.linkOptions(req.db, { projectId: plan.projectId, current: values });
  const project = plan.projectId ? await req.db.get('projects', plan.projectId) : null;
  const logframeResult = values.logframeId ? `${values.logframeId}:${values.logframeResultId || ''}` : '';
  res.status(status).render('workplans/activity-form', {
    title: isNew ? 'Add planned activity' : 'Edit planned activity', plan, values: { ...values, logframeResult }, errors, isNew, users, lfGroups, project,
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
