'use strict';
const express = require('express');
const svc = require('../../services/tasks');
const { canSeeCase } = require('../../access');
const { today } = require('../../helpers');
const h = require('../http');

const router = express.Router();

function withCase(t, cases) {
  const c = t.caseId ? cases[t.caseId] : null;
  return {
    ...h.present(t),
    overdue: !t.done && t.dueDate < today(),
    case: c ? { id: c.id, caseNumber: c.caseNumber, heading: c.heading, redacted: Boolean(c.redacted) } : null,
  };
}

/** Case summary for one task, hiding the heading of a confidential case the user cannot open. */
async function caseFor(req, t) {
  if (!t.caseId) return {};
  const c = await req.db.get('cases', t.caseId);
  if (!c) return {};
  return { [c.id]: canSeeCase(req.user, c) ? c : { ...c, heading: 'Confidential case', redacted: true } };
}

// who: me (default), all, or a user id. show: open (default) or done.
router.get('/tasks', async (req, res) => {
  const { tasks, cases } = await svc.listTasks(req, req.query);
  const { rows, meta } = h.pageOf(req, tasks);
  h.sendList(res, rows.map((t) => withCase(t, cases)), meta);
});

router.post('/tasks', async (req, res) => {
  const v = svc.readTask({ assigneeId: req.user.id, ...req.body });
  h.failIfInvalid(await svc.validateTask(req, v));
  const doc = await svc.createTask(req, v);
  h.sendOne(res, withCase(doc, await caseFor(req, doc)), 201, `${h.BASE}/tasks/${doc.id}`);
});

router.get('/tasks/:id', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  h.sendOne(res, withCase(t, await caseFor(req, t)));
});

router.patch('/tasks/:id', async (req, res) => {
  const saved = await h.saveWithRetry(req, async () => {
    const t = await svc.getTask(req, req.params.id);
    h.checkIfMatch(req, t);
    svc.assertCanEdit(req.user, t);
    const v = svc.readTask({ ...t, ...req.body });
    h.failIfInvalid(await svc.validateTask(req, v));
    return svc.updateTask(req, t, v, { ifMatch: t._etag });
  });
  h.sendOne(res, withCase(saved, await caseFor(req, saved)));
});

/** Mark done ({ "done": true }, the default) or reopen ({ "done": false }). */
router.post('/tasks/:id/done', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  const saved = await svc.setTaskDone(req, t, req.body.done !== false && req.body.done !== 'false');
  h.sendOne(res, withCase(saved, await caseFor(req, saved)));
});

router.delete('/tasks/:id', async (req, res) => {
  await svc.deleteTask(req, await svc.getTask(req, req.params.id));
  res.status(204).end();
});

router.get('/tasks/:id/calendar.ics', async (req, res) => {
  const t = await svc.getTask(req, req.params.id);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="task-${t.dueDate}.ics"`);
  res.send(svc.taskIcs(t));
});

module.exports = router;
