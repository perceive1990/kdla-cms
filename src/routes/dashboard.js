'use strict';
const express = require('express');
const choices = require('../choices');
const { tally, mapByIds, today } = require('../helpers');
const { visibleWhere, visibleMap } = require('../access');
const { searchAll, conflictCheck } = require('../services/search');

const router = express.Router();

router.get('/', async (req, res) => {
  const db = req.db;
  const year = today().slice(0, 4);
  const t0 = today(); const t14 = today(14);
  // Light projections keep request-unit cost low; fine for thousands of records.
  const [cases, clients, reportsCount, openReferrals, recent, myTasks, hearings] = await Promise.all([
    db.find('cases', { fields: ['id', 'status', 'caseTypes', 'office', 'openedOn', 'officerId', 'teamIds', 'outcome'] }),
    db.find('people', { where: { kind: 'client' }, fields: ['id', 'ageCategory', 'disability'] }),
    db.count('reports', {}),
    db.count('referrals', { where: { followUp: 'Needs follow up' } }),
    db.find('cases', { where: visibleWhere(req.user, {}), orderBy: ['updatedAt', 'DESC'], limit: 8 }),
    db.find('tasks', { where: { assigneeId: req.user.id, done: false, dueDate: { $lte: t14 } }, orderBy: ['dueDate', 'ASC'], limit: 12 }),
    db.find('tasks', {
      where: { done: false, type: { $in: ['Court hearing', 'Mediation session'] }, dueDate: { $gte: t0, $lte: t14 } },
      orderBy: ['dueDate', 'ASC'], limit: 10,
    }),
  ]);

  const isOpen = (c) => String(c.status).startsWith('Open');
  const mineOpen = cases.filter((c) => isOpen(c) && (c.officerId === req.user.id || (c.teamIds || []).includes(req.user.id))).length;
  const concluded = cases.filter((c) => !isOpen(c));
  const resolved = concluded.filter((c) => String(c.outcome || '').startsWith('Resolved') || String(c.outcome || '').includes('in favour')).length;

  const people = await mapByIds(db, 'people', recent.flatMap((c) => c.clientIds || []));
  const taskCases = visibleMap(req.user, await mapByIds(db, 'cases', [...myTasks, ...hearings].map((t) => t.caseId)));
  const users = await mapByIds(db, 'users', [...recent.map((c) => c.officerId), ...hearings.map((t) => t.assigneeId)]);
  const visibleHearings = hearings.filter((t) => !t.caseId || !taskCases[t.caseId] || !taskCases[t.caseId].redacted || t.assigneeId === req.user.id);

  res.render('dashboard', {
    title: 'Dashboard',
    stats: {
      total: cases.length,
      open: cases.filter(isOpen).length,
      thisYear: cases.filter((c) => String(c.openedOn).startsWith(year)).length,
      mine: mineOpen,
      clients: clients.length,
      reports: reportsCount,
      openReferrals,
      overdue: myTasks.filter((t) => t.dueDate < t0).length,
      concluded: concluded.length,
      resolved,
    },
    byStatus: tally(cases, 'status', choices.caseStatuses),
    byType: tally(cases, 'caseTypes').slice(0, 8),
    byOffice: tally(cases, 'office', choices.offices),
    byAgeCategory: tally(clients, 'ageCategory', choices.ageCategories),
    disabled: clients.filter((c) => c.disability === 'Disabled').length,
    recent, people, users, myTasks, hearings: visibleHearings, taskCases, t0,
  });
});

router.get('/search', async (req, res) => {
  const found = await searchAll(req, req.query.q);
  res.render('search', { title: 'Search', ...found });
});

// Conflict of interest check: who is this person to KDLA?
router.get('/conflicts', async (req, res) => {
  res.render('conflicts', { title: 'Conflict check', ...(await conflictCheck(req, req.query)) });
});

module.exports = router;
