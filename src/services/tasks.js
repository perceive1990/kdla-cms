'use strict';
// Rules for tasks, hearings and deadlines, shared by the web pages and the API.
const choices = require('../choices');
const config = require('../config');
const { audit } = require('../audit');
const { canSeeCase, visibleCase, isAdmin } = require('../access');
const {
  newId, now, str, mapByIds, isRealDate, today,
} = require('../helpers');
const { HttpError, notFound, forbidden } = require('./errors');

function readTask(body) {
  return {
    title: str(body.title, 200),
    type: str(body.type) || 'Task',
    dueDate: str(body.dueDate, 10),
    dueTime: str(body.dueTime, 5),
    location: str(body.location, 200),
    assigneeId: str(body.assigneeId),
    caseId: str(body.caseId),
    notes: str(body.notes, 2000),
  };
}

async function validateTask(req, v) {
  const e = {};
  if (!v.title) e.title = 'Describe the task, hearing or appointment.';
  if (!choices.taskTypes.includes(v.type)) e.type = 'Select a type.';
  if (!isRealDate(v.dueDate)) e.dueDate = 'Enter a date.';
  if (v.dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.dueTime)) e.dueTime = 'Enter a time like 09:30.';
  const assignee = v.assigneeId ? await req.db.get('users', v.assigneeId) : null;
  if (!assignee || assignee.active === false) e.assigneeId = 'Select who is responsible.';
  if (v.caseId) {
    const c = await req.db.get('cases', v.caseId);
    if (!c || !canSeeCase(req.user, c)) e.caseId = 'Select a valid case.';
  }
  return e;
}

/** Hide tasks on confidential cases from people outside the case (unless the task is theirs). */
async function visibleTasks(req, tasks) {
  const cases = await mapByIds(req.db, 'cases', tasks.map((t) => t.caseId));
  const list = tasks.filter((t) => !t.caseId || !cases[t.caseId] || canSeeCase(req.user, cases[t.caseId]) || t.assigneeId === req.user.id);
  const shown = {};
  for (const [id, c] of Object.entries(cases)) shown[id] = visibleCase(req.user, c);
  return { tasks: list, cases: shown };
}

/** Task list for the web page or the API. params: who (me, all or a user id), show (open or done), type, from, to. */
async function listTasks(req, params = {}) {
  const who = params.who === 'all' ? 'all' : (params.who || 'me');
  const show = params.show === 'done' ? 'done' : 'open';
  const where = { done: show === 'done' };
  if (who === 'me') where.assigneeId = req.user.id;
  else if (who !== 'all') where.assigneeId = String(who).slice(0, 60);
  if (choices.taskTypes.includes(params.type)) where.type = params.type;
  if (params.caseId) where.caseId = String(params.caseId).slice(0, 60);
  if (isRealDate(params.from)) where.dueDate = { $gte: params.from };
  if (isRealDate(params.to)) where.dueDate = { ...(where.dueDate || {}), $lte: params.to };
  const rows = await req.db.find('tasks', {
    where, orderBy: ['dueDate', show === 'done' ? 'DESC' : 'ASC'], limit: show === 'done' ? 200 : 500,
  });
  const { tasks, cases } = await visibleTasks(req, rows);
  return {
    who, show, tasks, cases,
  };
}

async function getTask(req, id) {
  const t = await req.db.get('tasks', id);
  if (!t) throw notFound('Task');
  if (t.caseId && t.assigneeId !== req.user.id) {
    const c = await req.db.get('cases', t.caseId);
    if (c && !canSeeCase(req.user, c)) throw new HttpError(403, 'confidential', 'This task belongs to a confidential case.');
  }
  return t;
}

function canEditTask(user, t) {
  return isAdmin(user) || t.assigneeId === user.id || t.createdBy === user.id;
}

function assertCanEdit(user, t) {
  if (!canEditTask(user, t)) throw forbidden('Only the person responsible, the creator or an administrator can change or delete this task.');
}

async function createTask(req, v) {
  const doc = { id: newId(), ...v, done: false, createdBy: req.user.id, createdAt: now(), updatedAt: now() };
  const saved = await req.db.create('tasks', doc);
  audit(req, 'create', 'tasks', doc.id, `${v.type}: ${v.title} on ${v.dueDate}`);
  return saved;
}

async function updateTask(req, t, v, { ifMatch } = {}) {
  assertCanEdit(req.user, t);
  const saved = await req.db.replace('tasks', { ...t, ...v, updatedAt: now() }, { ifMatch });
  audit(req, 'update', 'tasks', t.id, `${v.type}: ${v.title}`);
  return saved;
}

async function setTaskDone(req, t, done) {
  const saved = await req.db.replace('tasks', {
    ...t, done, doneAt: done ? now() : null, doneBy: done ? req.user.id : null, updatedAt: now(),
  });
  audit(req, 'update', 'tasks', t.id, `${done ? 'Completed' : 'Reopened'}: ${t.title}`);
  return saved;
}

async function deleteTask(req, t) {
  assertCanEdit(req.user, t);
  await req.db.remove('tasks', t.id);
  audit(req, 'delete', 'tasks', t.id, `${t.type}: ${t.title}`);
}

/** Convert a local date and time in the given time zone to a UTC Date. */
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (type) => Number(parts.find((x) => x.type === type).value);
  const asZone = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asZone - guess));
}

/** Calendar file (.ics) so a hearing or appointment can be added to a phone or Outlook calendar. */
function taskIcs(t) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const d = t.dueDate.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  let when;
  if (t.dueTime) {
    const start = zonedToUtc(t.dueDate, t.dueTime, config.displayTimeZone);
    const fmt = (dt) => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    when = [`DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 3600000))}`];
  } else {
    const next = new Date(`${t.dueDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    when = [`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`];
  }
  return `${[
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${config.orgName}//Case Management//EN`, 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${t.id}@kdla-cms`, `DTSTAMP:${stamp}`, ...when,
    `SUMMARY:${esc(`${t.type}: ${t.title}`)}`,
    t.location ? `LOCATION:${esc(t.location)}` : null,
    `DESCRIPTION:${esc(t.notes || '')}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(t.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')}\r\n`;
}

module.exports = {
  readTask, validateTask, visibleTasks, listTasks, getTask, canEditTask, assertCanEdit, createTask, updateTask, setTaskDone, deleteTask,
  taskIcs, zonedToUtc, today,
};
