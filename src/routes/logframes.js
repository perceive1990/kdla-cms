'use strict';
// M&E: each project's logframe with progress from work plans and activity reports.
const express = require('express');
const { audit } = require('../audit');
const { isAdmin } = require('../access');
const svc = require('../services/logframes');
const charts = require('../charts');
const { getProject } = require('../services/directory');
const { notFound } = require('../services/errors');
const {
  mapByIds, toCsv, sendCsv, today, str,
} = require('../helpers');

const router = express.Router();

/** Rule errors become a message on the logframe page; field problems found while saving show the form again. */
async function friendly(req, res, projectId, step, showForm = null) {
  try {
    return await step();
  } catch (e) {
    if (showForm && e.status === 422 && e.fields) {
      await showForm(e.fields);
      return null;
    }
    if (![403, 404, 409, 422].includes(e.status)) throw e;
    req.flash(e.status === 422 || e.status === 409 ? 'warning' : 'danger', e.message);
    res.redirect(projectId ? `/logframes/${projectId}` : '/logframes');
    return null;
  }
}

function adminOnly(req, res, projectId) {
  if (isAdmin(req.user)) return true;
  req.flash('warning', 'Only an administrator can change the logframe.');
  res.redirect(`/logframes/${projectId}`);
  return false;
}

async function load(req) {
  const project = await getProject(req.db, req.params.projectId);
  const fw = await svc.mustFramework(req.db, project.id);
  return { project, fw };
}

// ---------- List of projects ----------
router.get('/', async (req, res) => {
  const projects = await req.db.find('projects', { orderBy: ['startDate', 'DESC'] });
  const fws = await mapByIds(req.db, 'logframes', projects.map((p) => p.id));
  const summaries = {};
  for (const p of projects) {
    if (fws[p.id]) summaries[p.id] = (await svc.progress(req.db, fws[p.id], p)).totals;
  }
  res.render('logframes/index', {
    title: 'M&E', projects, fws, summaries, admin: isAdmin(req.user), elapsed: (p) => svc.timeElapsed(p),
  });
});

router.get('/template.csv', (req, res) => {
  sendCsv(res, 'logframe-template.csv', svc.template());
});

// ---------- One project's logframe ----------
router.post('/:projectId', async (req, res) => {
  const project = await getProject(req.db, req.params.projectId);
  if (!adminOnly(req, res, project.id)) return undefined;
  await svc.createFramework(req, project);
  req.flash('success', 'Logframe set up. Import it from a spreadsheet, or add the overall objective.');
  return res.redirect(`/logframes/${project.id}`);
});

router.get('/:projectId', async (req, res) => {
  const project = await getProject(req.db, req.params.projectId);
  const fw = await svc.getFramework(req.db, project.id);
  const admin = isAdmin(req.user);
  if (!fw) return res.render('logframes/show', { title: project.title, project, fw: null, admin });
  const prog = await svc.progress(req.db, fw, project);
  await require('../services/comments').attach(req, res, 'logframes', fw.id);
  const users = await mapByIds(req.db, 'users', [...prog.results.flatMap((r) => r.direct.map((d) => d.item.responsibleId))]);
  return res.render('logframes/show', {
    title: `${project.title} logframe`, project, fw, prog, admin, names: svc.names(fw), users, lf: svc.view, SOURCES: svc.SOURCES, charts, t0: today(), printLandscape: true,
  });
});

/** One page to print or save as PDF: key figures, the results chain, reach and the indicators. */
router.get('/:projectId/infographic', async (req, res) => {
  const { project, fw } = await load(req);
  const prog = await svc.progress(req.db, fw, project);
  res.render('logframes/infographic', {
    title: `${project.title} infographic`, project, fw, prog, admin: isAdmin(req.user), names: svc.names(fw), lf: svc.view, SOURCES: svc.SOURCES, charts, t0: today(), printLandscape: true,
  });
});

/** The classic logframe matrix: one row per indicator, printed on landscape A4. */
router.get('/:projectId/matrix', async (req, res) => {
  const { project, fw } = await load(req);
  const prog = await svc.progress(req.db, fw, project);
  res.render('logframes/matrix', {
    title: `${project.title} logframe matrix`, project, fw, prog, lf: svc.view, SOURCES: svc.SOURCES, charts, t0: today(), printLandscape: true,
  });
});

router.get('/:projectId/export.csv', async (req, res) => {
  const { project, fw } = await load(req);
  const prog = await svc.progress(req.db, fw, project);
  const csv = toCsv([
    { label: 'Level', value: 'level' }, { label: 'Code', value: 'code' }, { label: 'Text', value: 'text' },
    { label: 'Unit', value: 'unit' }, { label: 'Baseline', value: 'baseline' }, { label: 'Target', value: 'target' },
    { label: 'Means of verification', value: 'means' }, { label: 'Source', value: 'source' },
    { label: 'Actual', value: 'actual' }, { label: 'As at', value: 'asAt' }, { label: 'Progress (%)', value: 'pct' }, { label: 'Status', value: 'status' },
    { label: 'Planned activities linked', value: 'planned' }, { label: 'Activities held (reports)', value: 'delivered' }, { label: 'People reached', value: 'reach' },
  ], svc.exportRows(fw, prog));
  audit(req, 'export', 'logframes', fw.id, `Exported the logframe of ${project.title} to CSV`);
  sendCsv(res, `logframe-${project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${today()}.csv`, csv);
});

// ---------- Settings: level names, notes, delete ----------
router.get('/:projectId/settings', async (req, res) => {
  const { project, fw } = await load(req);
  if (!adminOnly(req, res, project.id)) return undefined;
  return res.render('logframes/settings', {
    title: 'Logframe settings', project, fw, values: { ...fw, ...Object.fromEntries(Object.entries(svc.names(fw)).map(([k, v]) => [`name_${k}`, v])) }, errors: {},
  });
});

router.post('/:projectId/settings', async (req, res) => {
  const { project, fw } = await load(req);
  if (!adminOnly(req, res, project.id)) return undefined;
  const saved = await friendly(req, res, project.id, () => svc.updateSettings(req, fw, svc.readSettings(req.body), { ifMatch: req.body._etag }));
  if (!saved) return undefined;
  req.flash('success', 'Logframe settings saved.');
  return res.redirect(`/logframes/${project.id}`);
});

router.post('/:projectId/delete', async (req, res) => {
  const { project, fw } = await load(req);
  if (!adminOnly(req, res, project.id)) return undefined;
  const result = await friendly(req, res, project.id, () => svc.deleteFramework(req, fw));
  if (!result) return undefined;
  req.flash('success', `Logframe deleted.${result.unlinked ? ` ${result.unlinked} planned activit${result.unlinked === 1 ? 'y was' : 'ies were'} unlinked.` : ''}`);
  return res.redirect('/logframes');
});

// ---------- Import from a spreadsheet ----------
router.get('/:projectId/import', async (req, res) => {
  const { project, fw } = await load(req);
  if (!adminOnly(req, res, project.id)) return undefined;
  return res.render('logframes/import', {
    title: 'Import the logframe', project, fw, outline: '', rowErrors: {}, error: '', columns: svc.IMPORT_COLUMNS, SOURCES: svc.SOURCES,
  });
});

// The form is sent as multipart/form-data; the app's upload step reads the CSV into memory (it is never stored).
router.post('/:projectId/import', async (req, res) => {
  const { project, fw } = await load(req);
  if (!adminOnly(req, res, project.id)) return undefined;
  const file = (req.files || [])[0];
  const outline = file ? file.buffer.toString('utf8') : String(req.body.outline || '');
  const again = (rowErrors, error) => res.status(400).render('logframes/import', {
    title: 'Import the logframe', project, fw, outline: file ? '' : outline, rowErrors, error, columns: svc.IMPORT_COLUMNS, SOURCES: svc.SOURCES,
  });
  if (file && file.buffer.subarray(0, 2).toString() === 'PK') {
    return again({}, 'This is an Excel workbook. In Excel choose File > Save As > CSV UTF-8, then import the CSV file, or copy the rows and paste them.');
  }
  try {
    const done = await svc.importOutline(req, fw, outline);
    req.flash('success', `Imported ${done.results} entries and ${done.indicators} indicators. Next, link the planned activities in your work plans to these outputs and activities.`);
    return res.redirect(`/logframes/${project.id}`);
  } catch (e) {
    if (e.rowErrors) return again(e.rowErrors, e.message);
    if (e.status === 409) return again({}, e.message);
    throw e;
  }
});

// ---------- Results: objective, intermediate objectives, outputs, activities ----------
function resultChoices(fw, level) {
  const parentLevel = svc.PARENT_LEVEL[level];
  if (!parentLevel || parentLevel === 'objective') return [];
  const codeMap = svc.codes(fw);
  return svc.ordered(fw).filter((r) => r.level === parentLevel).map((r) => ({ value: r.id, label: `${svc.labelOf(fw, r, codeMap)}: ${r.text.slice(0, 90)}` }));
}

function resultForm(req, res, { project, fw }, values, errors, isNew, status = 200) {
  const names = svc.names(fw);
  res.status(status).render('logframes/result-form', {
    title: isNew ? `Add ${names[values.level].toLowerCase()}` : `Edit ${names[values.level].toLowerCase()}`,
    project, fw, values, errors, isNew, names, parents: resultChoices(fw, values.level),
  });
}

router.get('/:projectId/results/new', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const level = svc.LEVELS.includes(req.query.level) ? req.query.level : 'objective';
  return resultForm(req, res, ctx, { level, parentId: str(req.query.parent, 60) }, {}, true);
});

router.post('/:projectId/results', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const v = svc.readResult(req.body);
  const again = (errors) => resultForm(req, res, ctx, v, errors, true, 400);
  const errors = svc.validateResult(ctx.fw, { ...v });
  if (Object.keys(errors).length) return again(errors);
  const done = await friendly(req, res, ctx.project.id, () => svc.addResult(req, ctx.fw, v), again);
  if (!done) return undefined;
  req.flash('success', `${svc.names(ctx.fw)[v.level]} added.`);
  return res.redirect(`/logframes/${ctx.project.id}#res-${done.result.id}`);
});

router.get('/:projectId/results/:resultId/edit', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  return resultForm(req, res, ctx, svc.getResult(ctx.fw, req.params.resultId), {}, false);
});

router.post('/:projectId/results/:resultId', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const old = svc.getResult(ctx.fw, req.params.resultId);
  const v = { ...svc.readResult(req.body), level: old.level };
  const again = (errors) => resultForm(req, res, ctx, { ...old, ...v }, errors, false, 400);
  const errors = svc.validateResult(ctx.fw, { ...v }, old.id);
  if (Object.keys(errors).length) return again(errors);
  const done = await friendly(req, res, ctx.project.id, () => svc.updateResult(req, ctx.fw, old.id, v), again);
  if (!done) return undefined;
  req.flash('success', 'Saved.');
  return res.redirect(`/logframes/${ctx.project.id}#res-${old.id}`);
});

router.post('/:projectId/results/:resultId/delete', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const done = await friendly(req, res, ctx.project.id, () => svc.deleteResult(req, ctx.fw, req.params.resultId));
  if (!done) return undefined;
  req.flash('success', `Removed.${done.unlinked ? ` ${done.unlinked} planned activit${done.unlinked === 1 ? 'y was' : 'ies were'} unlinked.` : ''}`);
  return res.redirect(`/logframes/${ctx.project.id}`);
});

// ---------- Indicators ----------
function indicatorForm(req, res, { project, fw }, values, errors, isNew, status = 200) {
  const codeMap = svc.codes(fw);
  const results = svc.ordered(fw).map((r) => ({ value: r.id, label: `${'\u2003'.repeat(r.depth)}${svc.labelOf(fw, r, codeMap)}: ${r.text.slice(0, 80)}` }));
  res.status(status).render('logframes/indicator-form', {
    title: isNew ? 'Add indicator' : 'Edit indicator', project, fw, values, errors, isNew, results, SOURCES: svc.SOURCES,
  });
}

router.get('/:projectId/indicators/new', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  return indicatorForm(req, res, ctx, {
    resultId: str(req.query.result, 60), unit: 'number', source: 'manual', baseline: 0,
  }, {}, true);
});

router.post('/:projectId/indicators', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const v = svc.readIndicator(req.body);
  const again = (errors) => indicatorForm(req, res, ctx, v, errors, true, 400);
  const errors = svc.validateIndicator(ctx.fw, v);
  if (Object.keys(errors).length) return again(errors);
  const done = await friendly(req, res, ctx.project.id, () => svc.addIndicator(req, ctx.fw, v), again);
  if (!done) return undefined;
  req.flash('success', 'Indicator added.');
  return res.redirect(`/logframes/${ctx.project.id}#res-${v.resultId}`);
});

router.get('/:projectId/indicators/:indicatorId/edit', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  return indicatorForm(req, res, ctx, svc.getIndicator(ctx.fw, req.params.indicatorId), {}, false);
});

router.post('/:projectId/indicators/:indicatorId', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const old = svc.getIndicator(ctx.fw, req.params.indicatorId);
  const v = svc.readIndicator(req.body);
  const again = (errors) => indicatorForm(req, res, ctx, { ...old, ...v }, errors, false, 400);
  const errors = svc.validateIndicator(ctx.fw, v);
  if (Object.keys(errors).length) return again(errors);
  const done = await friendly(req, res, ctx.project.id, () => svc.updateIndicator(req, ctx.fw, old.id, v), again);
  if (!done) return undefined;
  req.flash('success', 'Indicator saved.');
  return res.redirect(`/logframes/${ctx.project.id}#res-${v.resultId}`);
});

router.post('/:projectId/indicators/:indicatorId/delete', async (req, res) => {
  const ctx = await load(req);
  if (!adminOnly(req, res, ctx.project.id)) return undefined;
  const done = await friendly(req, res, ctx.project.id, () => svc.deleteIndicator(req, ctx.fw, req.params.indicatorId));
  if (!done) return undefined;
  req.flash('success', 'Indicator removed.');
  return res.redirect(`/logframes/${ctx.project.id}`);
});

// ---------- Recorded values (everyone) ----------
async function valuesPage(req, res, ctx, indicatorId, values, errors, status = 200) {
  const prog = await svc.progress(req.db, ctx.fw, ctx.project);
  const result = prog.results.find((r) => r.indicators.some((i) => i.id === indicatorId));
  if (!result) throw notFound('Indicator');
  const ind = result.indicators.find((i) => i.id === indicatorId);
  const users = await mapByIds(req.db, 'users', (ind.values || []).map((x) => x.by));
  res.status(status).render('logframes/values', {
    title: ind.name, project: ctx.project, fw: ctx.fw, result, ind, values, errors, users, lf: svc.view, SOURCES: svc.SOURCES, admin: isAdmin(req.user),
  });
}

router.get('/:projectId/indicators/:indicatorId', async (req, res) => {
  const ctx = await load(req);
  svc.getIndicator(ctx.fw, req.params.indicatorId);
  return valuesPage(req, res, ctx, req.params.indicatorId, { date: today() }, {});
});

router.post('/:projectId/indicators/:indicatorId/values', async (req, res) => {
  const ctx = await load(req);
  const ind = svc.getIndicator(ctx.fw, req.params.indicatorId);
  const v = svc.readValue(req.body);
  const again = (errors) => valuesPage(req, res, ctx, ind.id, v, errors, 400);
  const errors = svc.validateValue(ind, v);
  if (Object.keys(errors).length) return again(errors);
  const done = await friendly(req, res, ctx.project.id, () => svc.addValue(req, ctx.fw, ind.id, v), again);
  if (!done) return undefined;
  req.flash('success', 'Value recorded.');
  return res.redirect(`/logframes/${ctx.project.id}/indicators/${ind.id}`);
});

router.post('/:projectId/indicators/:indicatorId/values/:valueId/delete', async (req, res) => {
  const ctx = await load(req);
  const done = await friendly(req, res, ctx.project.id, () => svc.deleteValue(req, ctx.fw, req.params.indicatorId, req.params.valueId));
  if (!done) return undefined;
  req.flash('success', 'Value removed.');
  return res.redirect(`/logframes/${ctx.project.id}/indicators/${req.params.indicatorId}`);
});

module.exports = router;
