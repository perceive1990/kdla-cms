'use strict';
const express = require('express');
const choices = require('../choices');
const { visibleWhere } = require('../access');
const { safeBack } = require('../middleware');
const svc = require('../services/tasks');
const { str, today, fmtDate } = require('../helpers');

const router = express.Router();

async function formLists(req) {
  const [users, cases] = await Promise.all([
    req.db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username', 'role'], orderBy: ['username', 'ASC'] }).then((us) => us.filter((u) => u.role !== 'viewer')),
    req.db.find('cases', {
      where: visibleWhere(req.user, { status: { $in: choices.caseStatuses.filter((s) => s.startsWith('Open')) } }),
      fields: ['id', 'caseNumber', 'heading'], orderBy: ['updatedAt', 'DESC'],
    }),
  ]);
  return { users, cases };
}

router.get('/', async (req, res) => {
  const { who, show, tasks, cases } = await svc.listTasks(req, { who: req.query.who, show: req.query.show, type: req.query.type });
  const users = await req.db.find('users', { fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] });
  const t0 = today(); const t7 = today(7);
  const groups = show === 'done'
    ? [{ label: 'Completed', items: tasks }]
    : [
      { label: 'Overdue', tone: 'danger', items: tasks.filter((t) => t.dueDate < t0) },
      { label: 'Today', tone: 'warning', items: tasks.filter((t) => t.dueDate === t0) },
      { label: 'Next 7 days', items: tasks.filter((t) => t.dueDate > t0 && t.dueDate <= t7) },
      { label: 'Later', items: tasks.filter((t) => t.dueDate > t7) },
    ];
  res.render('tasks/list', {
    title: 'Tasks and hearings', groups, cases, users, usersById: Object.fromEntries(users.map((u) => [u.id, u])), who, show, total: tasks.length,
  });
});

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
/** The signed-in person's overdue tasks, as counted for the badge in the menu. */
const overdueCount = (req) => req.db.count('tasks', { where: { assigneeId: req.user.id, done: false, dueDate: { $lt: today() } } });

// Data for the live (Vue) task list: the same tasks as the page (whose and which, chosen on the server),
// with the case each belongs to (confidential cases stay hidden) and labels ready to show.
router.get('/data', async (req, res) => {
  const { who, show, tasks, cases } = await svc.listTasks(req, { who: req.query.who, show: req.query.show });
  const users = await req.db.find('users', { fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const name = (id) => (byId[id] ? byId[id].fullName || byId[id].username : 'Former user');
  res.json({
    who, show, me: req.user.id, today: today(), week: today(7), types: choices.taskTypes,
    users: users.map((u) => ({ id: u.id, name: u.fullName || u.username })),
    tasks: tasks.map((t) => {
      const c = t.caseId && cases[t.caseId];
      return {
        id: t.id,
        title: t.title,
        type: t.type,
        due: t.dueDate,
        dueLabel: fmtDate(t.dueDate),
        time: t.dueTime || '',
        location: t.location || '',
        notes: t.notes || '',
        done: t.done === true,
        assignee: name(t.assigneeId),
        case: c ? { id: c.id, no: c.caseNumber, heading: c.redacted ? '' : c.heading } : null,
      };
    }),
  });
});

router.get('/new', async (req, res) => {
  const values = { type: str(req.query.type) || 'Task', dueDate: today(1), assigneeId: req.user.id, caseId: str(req.query.case) };
  res.render('tasks/form', { title: 'New task or hearing', values, errors: {}, isNew: true, ...(await formLists(req)) });
});

router.post('/', async (req, res) => {
  const v = svc.readTask(req.body);
  const errors = await svc.validateTask(req, v);
  const back = str(req.body.returnTo, 200);
  if (Object.keys(errors).length) {
    return res.status(400).render('tasks/form', { title: 'New task or hearing', values: v, errors, isNew: true, ...(await formLists(req)) });
  }
  await svc.createTask(req, v);
  req.flash('success', `${v.type} added for ${v.dueDate}.`);
  return res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/tasks');
});

router.get('/:id/calendar.ics', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="task-${t.dueDate}.ics"`);
  res.send(svc.taskIcs(t));
});

router.get('/:id/edit', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  return res.render('tasks/form', { title: 'Edit task', values: t, errors: {}, isNew: false, ...(await formLists(req)) });
});

router.post('/:id', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  svc.assertCanEdit(req.user, t);
  const v = svc.readTask(req.body);
  const errors = await svc.validateTask(req, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('tasks/form', { title: 'Edit task', values: { ...t, ...v }, errors, isNew: false, ...(await formLists(req)) });
  }
  await svc.updateTask(req, t, v);
  req.flash('success', 'Task updated.');
  return res.redirect(v.caseId ? `/cases/${v.caseId}#tasks` : '/tasks');
});

router.post('/:id/done', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  const done = req.body.done !== 'false';
  await svc.setTaskDone(req, t, done);
  // The live screens tick tasks off without reloading: they get the new state and the overdue count back.
  if (wantsJson(req)) return res.json({ ok: true, id: t.id, done, overdue: await overdueCount(req) });
  return res.redirect(safeBack(req, '/tasks'));
});

router.post('/:id/delete', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  await svc.deleteTask(req, t);
  req.flash('success', 'Task deleted.');
  return res.redirect(t.caseId ? `/cases/${t.caseId}#tasks` : '/tasks');
});

module.exports = router;
