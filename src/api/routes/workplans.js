'use strict';
// Work plans and their planned activities. Same rules as the web pages (src/services/workplans.js).
// Every change returns the whole plan with its new etag: the plan is the record that carries the version.
const express = require('express');
const choices = require('../../choices');
const svc = require('../../services/workplans');
const { CURRENCIES } = require('../../services/directory');
const { adminOnly } = require('../auth');
const h = require('../http');

const router = express.Router();
const SORTS = ['periodStart', 'createdAt', 'updatedAt'];
const PLAN_LISTS = { office: choices.offices, currency: CURRENCIES };
const ACTIVITY_LISTS = { activityType: choices.activities, district: choices.districts, status: choices.workplanActivityStatuses };

/** A planned activity for the API: the linked reports in short. */
function presentActivity(it) {
  const { reports, ...rest } = it;
  return reports ? { ...rest, reports: reports.map((r) => ({ id: r.id, heading: r.heading, date: r.date })) } : rest;
}

/** A plan for the API: "items" are called "activities", with progress when it is known. */
function presentPlan(plan, prog = null) {
  const { items, ...rest } = plan;
  return {
    ...h.present(rest),
    activities: (prog ? prog.items : items || []).map(presentActivity),
    ...(prog && { totals: prog.totals }),
  };
}

const full = async (req, plan) => presentPlan(plan, await svc.progress(req.db, plan));
/** The version the client read, when it sent If-Match; otherwise the save is applied to the latest version. */
const strictly = (req, plan) => (req.get('if-match') ? plan._etag : undefined);

router.get('/workplans', async (req, res) => {
  const { rows, meta } = await h.findPage(req, 'workplans', svc.planQuery(req.query), h.sortParam(req, SORTS, ['periodStart', 'DESC']));
  const totals = await svc.totalsFor(req.db, rows);
  h.sendList(res, rows.map((p) => ({ ...presentPlan(p), totals: totals[p.id] })), meta);
});

router.post('/workplans', async (req, res) => {
  const v = svc.readPlan({ preparedById: req.user.id, ...req.body });
  h.failIfInvalid({ ...h.checkChoices(req.body, PLAN_LISTS), ...(await svc.validatePlan(req.db, v)) });
  const doc = await svc.createPlan(req, v);
  h.sendOne(res, await full(req, doc), 201, `${h.BASE}/workplans/${doc.id}`);
});

router.get('/workplans/:id', async (req, res) => {
  h.sendOne(res, await full(req, await svc.getPlan(req.db, req.params.id)));
});

router.patch('/workplans/:id', async (req, res) => {
  const moveActivities = req.body.moveActivities === true;
  const saved = await h.saveWithRetry(req, async () => {
    const plan = await svc.getPlan(req.db, req.params.id);
    h.checkIfMatch(req, plan);
    const v = svc.readPlan({ ...plan, ...req.body });
    h.failIfInvalid({ ...h.checkChoices(req.body, PLAN_LISTS), ...(await svc.validatePlan(req.db, v, plan, { moveActivities })) });
    return svc.updatePlan(req, plan, v, { ifMatch: plan._etag, moveActivities });
  });
  h.sendOne(res, await full(req, saved));
});

router.delete('/workplans/:id', adminOnly, async (req, res) => {
  await svc.deletePlan(req, await svc.getPlan(req.db, req.params.id));
  res.status(204).end();
});

/** Administrators: { "status": "Approved" | "Draft" | "Closed" }. */
router.post('/workplans/:id/status', adminOnly, async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  h.checkIfMatch(req, plan);
  const saved = await svc.setPlanStatus(req, plan, String(req.body.status || ''), { ifMatch: strictly(req, plan) });
  h.sendOne(res, await full(req, saved));
});

router.post('/workplans/:id/copy', async (req, res) => {
  const doc = await svc.copyPlan(req, await svc.getPlan(req.db, req.params.id));
  h.sendOne(res, await full(req, doc), 201, `${h.BASE}/workplans/${doc.id}`);
});

// ---------- Planned activities ----------
router.post('/workplans/:id/activities', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  h.checkIfMatch(req, plan);
  const v = svc.readActivity(req.body);
  h.failIfInvalid({ ...h.checkChoices(req.body, ACTIVITY_LISTS), ...(await svc.validateActivity(req.db, plan, v)) });
  const { plan: saved, item } = await svc.addActivity(req, plan, v, { ifMatch: strictly(req, plan) });
  h.sendOne(res, await full(req, saved), 201, `${h.BASE}/workplans/${plan.id}/activities/${item.id}`);
});

router.get('/workplans/:id/activities/:itemId', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  svc.getItem(plan, req.params.itemId);
  const { items } = await svc.progress(req.db, plan);
  res.json(presentActivity(items.find((it) => it.id === req.params.itemId)));
});

router.patch('/workplans/:id/activities/:itemId', async (req, res) => {
  const saved = await h.saveWithRetry(req, async () => {
    const plan = await svc.getPlan(req.db, req.params.id);
    h.checkIfMatch(req, plan);
    const old = svc.getItem(plan, req.params.itemId);
    const v = svc.readActivity({ ...old, ...req.body });
    h.failIfInvalid({ ...h.checkChoices(req.body, ACTIVITY_LISTS), ...(await svc.validateActivity(req.db, plan, v, old.id)) });
    return (await svc.updateActivity(req, plan, old.id, v, { ifMatch: plan._etag })).plan;
  });
  h.sendOne(res, await full(req, saved));
});

/** Progress: { "status": "In progress" }. Anyone may do this while the plan is not closed. */
router.post('/workplans/:id/activities/:itemId/status', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  h.checkIfMatch(req, plan);
  const { plan: saved } = await svc.setActivityStatus(req, plan, req.params.itemId, String(req.body.status || ''), { ifMatch: strictly(req, plan) });
  h.sendOne(res, await full(req, saved));
});

router.delete('/workplans/:id/activities/:itemId', async (req, res) => {
  const plan = await svc.getPlan(req.db, req.params.id);
  h.checkIfMatch(req, plan);
  await svc.deleteActivity(req, plan, req.params.itemId, { ifMatch: strictly(req, plan) });
  res.status(204).end();
});

module.exports = router;
