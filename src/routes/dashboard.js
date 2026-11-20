'use strict';
const express = require('express');
const choices = require('../choices');
const {
  tally, mapByIds, today, fmtDate, fullName, statusBadge,
} = require('../helpers');
const { visibleWhere, visibleMap } = require('../access');
const { searchAll, conflictCheck } = require('../services/search');
const workplans = require('../services/workplans');

const router = express.Router();

const isOpen = (c) => String(c.status).startsWith('Open');

/**
 * The parts of the dashboard that refresh themselves (the live Vue screen asks for them again every minute while
 * someone is using the page): the four counts at the top, my tasks, the hearings and the recently updated cases.
 */
async function liveParts(req) {
  const { db } = req;
  const t0 = today(); const t14 = today(14);
  // Light projections keep request-unit cost low; fine for thousands of records.
  const [cases, openReferrals, overdue, recent, myTasks, hearings] = await Promise.all([
    db.find('cases', { fields: ['id', 'status', 'caseTypes', 'office', 'openedOn', 'officerId', 'teamIds', 'outcome'] }),
    db.count('referrals', { where: { followUp: 'Needs follow up' } }),
    db.count('tasks', { where: { assigneeId: req.user.id, done: false, dueDate: { $lt: t0 } } }),
    db.find('cases', {
      where: visibleWhere(req.user, {}), fields: ['id', 'caseNumber', 'heading', 'restricted', 'clientIds', 'status', 'officerId', 'updatedAt'], orderBy: ['updatedAt', 'DESC'], limit: 8,
    }),
    db.find('tasks', { where: { assigneeId: req.user.id, done: false, dueDate: { $lte: t14 } }, orderBy: ['dueDate', 'ASC'], limit: 12 }),
    db.find('tasks', {
      where: { done: false, type: { $in: ['Court hearing', 'Mediation session'] }, dueDate: { $gte: t0, $lte: t14 } },
      orderBy: ['dueDate', 'ASC'], limit: 10,
    }),
  ]);
  const mine = cases.filter((c) => isOpen(c) && (c.officerId === req.user.id || (c.teamIds || []).includes(req.user.id))).length;
  const people = await mapByIds(db, 'people', recent.flatMap((c) => c.clientIds || []));
  const taskCases = visibleMap(req.user, await mapByIds(db, 'cases', [...myTasks, ...hearings].map((t) => t.caseId)));
  const users = await mapByIds(db, 'users', [...recent.map((c) => c.officerId), ...hearings.map((t) => t.assigneeId)]);
  const visibleHearings = hearings.filter((t) => !t.caseId || !taskCases[t.caseId] || !taskCases[t.caseId].redacted || t.assigneeId === req.user.id);
  return {
    t0, cases, recent, people, users, myTasks, hearings: visibleHearings, taskCases,
    stats: {
      mine, overdue, open: cases.filter(isOpen).length, openReferrals,
    },
  };
}

router.get('/', async (req, res) => {
  const { db } = req;
  const year = today().slice(0, 4);
  const [live, clients, reportsCount, myActivities] = await Promise.all([
    liveParts(req),
    db.find('people', { where: { kind: 'client' }, fields: ['id', 'ageCategory', 'disability'] }),
    db.count('reports', {}),
    workplans.dueFor(db, req.user.id, 30),
  ]);
  const { cases } = live;
  const concluded = cases.filter((c) => !isOpen(c));
  const resolved = concluded.filter((c) => String(c.outcome || '').startsWith('Resolved') || String(c.outcome || '').includes('in favour')).length;

  res.render('dashboard', {
    title: 'Dashboard',
    stats: {
      ...live.stats,
      total: cases.length,
      thisYear: cases.filter((c) => String(c.openedOn).startsWith(year)).length,
      clients: clients.length,
      reports: reportsCount,
      concluded: concluded.length,
      resolved,
    },
    byStatus: tally(cases, 'status', choices.caseStatuses),
    byType: tally(cases, 'caseTypes').slice(0, 8),
    byOffice: tally(cases, 'office', choices.offices),
    byAgeCategory: tally(clients, 'ageCategory', choices.ageCategories),
    disabled: clients.filter((c) => c.disability === 'Disabled').length,
    recent: live.recent,
    people: live.people,
    users: live.users,
    myTasks: live.myTasks,
    hearings: live.hearings,
    taskCases: live.taskCases,
    t0: live.t0,
    myActivities,
    attendanceWaiting: req.user.role === 'admin' ? await db.count('reports', { where: { attendanceStatus: 'Submitted' } }) : 0,
  });
});

// Data for the live dashboard: the same counts and lists as the page, with labels ready to show.
router.get('/dashboard/data', async (req, res) => {
  const d = await liveParts(req);
  const when = (t) => `${fmtDate(t.dueDate)}${t.dueTime ? ` ${t.dueTime}` : ''}`;
  const uname = (id) => (d.users[id] ? d.users[id].fullName || d.users[id].username : '');
  const caseLabel = (t) => {
    const c = t.caseId && d.taskCases[t.caseId];
    return c ? c.caseNumber + (c.redacted ? '' : ` · ${c.heading}`) : '';
  };
  res.json({
    stats: d.stats,
    myTasks: d.myTasks.map((t) => ({
      id: t.id, title: t.title, type: t.type, when: when(t), overdue: t.dueDate < d.t0, caseId: t.caseId || '', caseLabel: caseLabel(t),
    })),
    hearings: d.hearings.map((t) => ({
      id: t.id, title: t.title, type: t.type, location: t.location || '', who: uname(t.assigneeId), when: when(t),
    })),
    recent: d.recent.map((c) => ({
      id: c.id,
      heading: c.heading,
      no: c.caseNumber,
      restricted: c.restricted === true,
      clients: (c.clientIds || []).map((id) => fullName(d.people[id])).filter(Boolean).join(', '),
      status: c.status,
      badge: statusBadge(c.status),
      officer: uname(c.officerId),
      updated: fmtDate(c.updatedAt),
    })),
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
