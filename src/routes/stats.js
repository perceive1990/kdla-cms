'use strict';
// Statistics page and CSV export. The figures themselves are worked out in services/stats.js,
// so the API returns exactly the same numbers.
const express = require('express');
const { audit } = require('../audit');
const {
  period, compute, statsRows, BEN_KINDS, benPeriod, beneficiaries, beneficiaryRows,
} = require('../services/stats');
const { toCsv, sendCsv, today } = require('../helpers');
const charts = require('../charts');

const router = express.Router();

router.get('/', async (req, res) => {
  const p = period(req.query);
  const projects = await req.db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] });
  const s = p.from <= p.to ? await compute(req.db, p) : null;
  res.render('stats', { title: 'Statistics', p, s, projects });
});

// One-page infographic for donors, boards and community meetings (printable).
router.get('/infographic', async (req, res) => {
  const p = period(req.query);
  const projects = await req.db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] });
  if (p.from > p.to) return res.render('infographic', { title: 'Infographic', p, s: null, projects });
  const s = await compute(req.db, p);
  const opened = await req.db.find('cases', {
    where: { ...(p.office ? { office: p.office } : {}), openedOn: { $gte: p.from, $lte: p.to } }, fields: ['openedOn'],
  });
  const byCount = (list) => list.filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  const project = p.projectId ? projects.find((x) => x.id === p.projectId) : null;
  return res.render('infographic', {
    title: 'Infographic', p, s, projects, project, charts, generated: today(),
    months: charts.monthly(opened.map((c) => c.openedOn), p.from, p.to),
    types: byCount(s.openedByType),
    outcomes: byCount(s.closedByOutcome),
    activities: byCount(s.activitiesByType),
    districts: byCount(s.activitiesByDistrict),
  });
});

const people = require('../services/people');
/** Adds every stored spelling of the chosen community to the filters. */
function withCommunity(p, comms) {
  const c = comms.find((x) => x.key === people.communityKey(p.community));
  return { ...p, community: c ? c.name : p.community, communityValues: c ? c.values : [] };
}

// Statistics of all registered beneficiaries (clients, other parties and activity attendees), printable.
router.get('/beneficiaries', async (req, res) => {
  const p = benPeriod(req.query);
  const projects = await req.db.find('projects', { fields: ['id', 'title', 'donor'], orderBy: ['title', 'ASC'] });
  const comms = await people.communities(req.db, p.kind);
  const b = await beneficiaries(req.db, withCommunity(p, comms));
  res.render('stats-beneficiaries', {
    title: 'Beneficiary statistics', p, b, projects, comms, project: projects.find((x) => x.id === p.projectId) || null, BEN_KINDS, charts, generated: today(),
  });
});

router.get('/beneficiaries.csv', async (req, res) => {
  const p = benPeriod(req.query);
  const b = await beneficiaries(req.db, withCommunity(p, await people.communities(req.db, p.kind)));
  audit(req, 'export', 'statistics', null, 'Exported beneficiary statistics');
  sendCsv(res, `beneficiary-statistics-${today()}.csv`, toCsv([
    { label: 'Section', value: 'section' }, { label: 'Item', value: 'item' }, { label: 'Value', value: 'value' },
  ], beneficiaryRows(p, b)));
});

router.get('/export.csv', async (req, res) => {
  const p = period(req.query);
  const s = await compute(req.db, p);
  audit(req, 'export', 'statistics', null, `Exported statistics ${p.from} to ${p.to}`);
  sendCsv(res, `statistics-${p.from}-to-${p.to}.csv`, toCsv([
    { label: 'Section', value: 'section' }, { label: 'Item', value: 'item' }, { label: 'Value', value: 'value' },
  ], statsRows(p, s)));
});

module.exports = router;
