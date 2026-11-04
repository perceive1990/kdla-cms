'use strict';
// M&E: each project's logframe, with progress. Same rules as the web pages (src/services/logframes.js).
// Every change returns the whole logframe with its new etag.
const express = require('express');
const svc = require('../../services/logframes');
const { getProject } = require('../../services/directory');
const { adminOnly } = require('../auth');
const h = require('../http');

const router = express.Router();
const BASE = (id) => `${h.BASE}/projects/${id}/logframe`;

/** The logframe for the API: results in reading order with their numbers, indicators with progress. */
function presentLogframe(fw, prog) {
  const { results, indicators, ...rest } = fw;
  return {
    ...h.present(rest),
    elapsed: prog.elapsed,
    totals: prog.totals,
    results: prog.results.map((r) => ({
      id: r.id,
      level: r.level,
      parentId: r.parentId || '',
      code: r.code,
      customCode: (results.find((x) => x.id === r.id) || {}).code || '',
      label: r.label,
      text: r.text,
      rollup: r.rollup,
      indicators: r.indicators.map((i) => ({
        id: i.id, name: i.name, unit: i.unit, baseline: i.baseline, target: i.target, source: i.source, means: i.means, frequency: i.frequency,
        actual: i.actual, asAt: i.asAt, automatic: i.automatic, pct: i.pct, status: i.status, values: i.values || [],
      })),
      plannedActivities: r.direct.map((d) => ({
        workplanId: d.plan.id, workplanTitle: d.plan.title, activityId: d.item.id, number: d.item.number, title: d.item.title, status: d.item.status, delivered: d.delivered,
      })),
    })),
    unlinked: prog.unlinked.map((u) => ({
      workplanId: u.plan.id, workplanTitle: u.plan.title, activityId: u.item.id, number: u.item.number, title: u.item.title,
    })),
  };
}

async function load(req) {
  const project = await getProject(req.db, req.params.id);
  return { project, fw: await svc.mustFramework(req.db, project.id) };
}

const full = async (req, project, fw) => presentLogframe(fw, await svc.progress(req.db, fw, project));
/** The version the client read, when it sent If-Match; otherwise the change is applied to the latest version. */
const strictly = (req, fw) => {
  h.checkIfMatch(req, fw);
  return req.get('if-match') ? fw._etag : undefined;
};

router.get('/projects/:id/logframe', async (req, res) => {
  const { project, fw } = await load(req);
  h.sendOne(res, await full(req, project, fw));
});

router.post('/projects/:id/logframe', adminOnly, async (req, res) => {
  const project = await getProject(req.db, req.params.id);
  const existed = await svc.getFramework(req.db, project.id);
  const fw = await svc.createFramework(req, project);
  h.sendOne(res, await full(req, project, fw), existed ? 200 : 201, BASE(project.id));
});

router.patch('/projects/:id/logframe', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  const ifMatch = strictly(req, fw);
  const v = svc.readSettings({ names: { ...svc.names(fw), ...(req.body.names || {}) }, notes: req.body.notes ?? fw.notes });
  const saved = await svc.updateSettings(req, fw, v, { ifMatch });
  h.sendOne(res, await full(req, project, saved));
});

router.delete('/projects/:id/logframe', adminOnly, async (req, res) => {
  const { fw } = await load(req);
  await svc.deleteFramework(req, fw);
  res.status(204).end();
});

/** Body { "csv": "Level,Code,Text,..." }: the same rows as the web import, into an empty logframe only. */
router.post('/projects/:id/logframe/import', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  if (typeof req.body.csv !== 'string') throw h.invalid({ csv: 'Send the rows as "csv", a string.' });
  const done = await svc.importOutline(req, fw, req.body.csv);
  res.json({ imported: { results: done.results, indicators: done.indicators }, logframe: await full(req, project, done.framework) });
});

// ---------- Results ----------
router.post('/projects/:id/logframe/results', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  const v = svc.readResult(req.body);
  h.failIfInvalid(svc.validateResult(fw, { ...v }));
  const { framework } = await svc.addResult(req, fw, v);
  h.sendOne(res, await full(req, project, framework), 201, BASE(project.id));
});

router.patch('/projects/:id/logframe/results/:resultId', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  const ifMatch = strictly(req, fw);
  const old = svc.getResult(fw, req.params.resultId);
  const v = { ...svc.readResult({ ...old, ...req.body }), level: old.level };
  h.failIfInvalid(svc.validateResult(fw, { ...v }, old.id));
  const { framework } = await svc.updateResult(req, fw, old.id, v, { ifMatch });
  h.sendOne(res, await full(req, project, framework));
});

router.delete('/projects/:id/logframe/results/:resultId', adminOnly, async (req, res) => {
  const { fw } = await load(req);
  await svc.deleteResult(req, fw, req.params.resultId, { ifMatch: strictly(req, fw) });
  res.status(204).end();
});

// ---------- Indicators ----------
router.post('/projects/:id/logframe/indicators', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  const v = svc.readIndicator(req.body);
  h.failIfInvalid(svc.validateIndicator(fw, v));
  const { framework } = await svc.addIndicator(req, fw, v);
  h.sendOne(res, await full(req, project, framework), 201, BASE(project.id));
});

router.patch('/projects/:id/logframe/indicators/:indicatorId', adminOnly, async (req, res) => {
  const { project, fw } = await load(req);
  const ifMatch = strictly(req, fw);
  const old = svc.getIndicator(fw, req.params.indicatorId);
  const v = svc.readIndicator({ ...old, ...req.body });
  h.failIfInvalid(svc.validateIndicator(fw, v));
  const { framework } = await svc.updateIndicator(req, fw, old.id, v, { ifMatch });
  h.sendOne(res, await full(req, project, framework));
});

router.delete('/projects/:id/logframe/indicators/:indicatorId', adminOnly, async (req, res) => {
  const { fw } = await load(req);
  await svc.deleteIndicator(req, fw, req.params.indicatorId, { ifMatch: strictly(req, fw) });
  res.status(204).end();
});

/** Anyone: { "date": "2026-09-30", "value": 23, "note": "From the Q3 reports" } for an indicator recorded by staff. */
router.post('/projects/:id/logframe/indicators/:indicatorId/values', async (req, res) => {
  const { project, fw } = await load(req);
  const ind = svc.getIndicator(fw, req.params.indicatorId);
  const v = svc.readValue(req.body);
  if (ind.source === 'manual') h.failIfInvalid(svc.validateValue(ind, v));
  const { framework } = await svc.addValue(req, fw, ind.id, v);
  h.sendOne(res, await full(req, project, framework), 201, BASE(project.id));
});

router.delete('/projects/:id/logframe/indicators/:indicatorId/values/:valueId', async (req, res) => {
  const { fw } = await load(req);
  await svc.deleteValue(req, fw, req.params.indicatorId, req.params.valueId);
  res.status(204).end();
});

module.exports = router;
