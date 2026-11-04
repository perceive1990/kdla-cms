'use strict';
// Work plans: a plan for a period (for example a quarter or a year), optionally for one project and
// office, with numbered planned activities. Activity reports link to a planned activity, so each plan
// shows what was planned against what was delivered. Shared by the web pages and the API.
//
// Who may do what:
//   - Everyone can read plans, start a new plan and copy a plan.
//   - A draft plan can be changed by everyone; an approved plan only by administrators.
//   - Anyone can update the progress status of an activity while the plan is not closed.
//   - Administrators approve, return to draft, close, reopen and delete plans. A closed plan cannot
//     be changed until an administrator reopens it.
const choices = require('../choices');
const { audit } = require('../audit');
const { isAdmin } = require('../access');
const { CURRENCIES } = require('./directory');
const {
  newId, now, str, intOrNull, isRealDate, today, mapByIds, daysBetween,
} = require('../helpers');
const { HttpError, notFound, forbidden } = require('./errors');

const DONE = ['Completed', 'Cancelled'];

const invalid = (fields) => new HttpError(422, 'validation_failed', Object.values(fields)[0], { fields });
const changedMeanwhile = () => Object.assign(new Error('Precondition failed'), { code: 412 });

function amountOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// ---------- The plan ----------
function readPlan(body) {
  return {
    title: str(body.title, 200),
    projectId: str(body.projectId),
    office: str(body.office),
    periodStart: str(body.periodStart, 10),
    periodEnd: str(body.periodEnd, 10),
    currency: CURRENCIES.includes(body.currency) ? body.currency : 'ZMW',
    notes: str(body.notes, 4000),
    preparedById: str(body.preparedById),
  };
}

/** Planned activities with a date outside a period. */
const outsidePeriod = (items, v) => (items || []).filter((it) => (it.startDate && it.startDate < v.periodStart) || (it.endDate && it.endDate > v.periodEnd));
const outsideMessage = (n) => `${n} planned activit${n === 1 ? 'y has' : 'ies have'} dates outside this period. Change ${n === 1 ? 'that activity' : 'those activities'} first, or move the start of the plan with "Move the activity dates with the plan" ticked.`;

async function validatePlan(db, v, plan = null, { moveActivities = false } = {}) {
  const e = {};
  if (!v.title) e.title = 'Enter a title, for example "Kitwe Office work plan, January to March 2027".';
  if (!isRealDate(v.periodStart)) e.periodStart = 'Enter the first day of the plan.';
  if (!isRealDate(v.periodEnd)) e.periodEnd = 'Enter the last day of the plan.';
  if (!e.periodStart && !e.periodEnd && v.periodEnd < v.periodStart) e.periodEnd = 'The end must be on or after the start.';
  if (v.office && !choices.offices.includes(v.office)) e.office = 'Select a valid office.';
  if (v.projectId && !(await db.get('projects', v.projectId))) e.projectId = 'Select a valid project.';
  if (v.preparedById && !(await db.get('users', v.preparedById))) e.preparedById = 'Select a valid colleague.';
  if (plan && !e.periodStart && !e.periodEnd && !movesActivities(plan, v, moveActivities)) {
    const outside = outsidePeriod(plan.items, v);
    if (outside.length) e.periodEnd = outsideMessage(outside.length);
  }
  return e;
}

/** Activities move with the plan only when its start moves (copying last quarter's plan to the next one). */
const movesActivities = (plan, v, moveActivities) => Boolean(moveActivities && (plan.items || []).length && v.periodStart !== plan.periodStart);

function planQuery(params = {}) {
  const where = {};
  if (choices.workplanStatuses.includes(params.status)) where.status = params.status;
  if (choices.offices.includes(params.office)) where.office = params.office;
  if (params.projectId) where.projectId = String(params.projectId).slice(0, 60);
  const q = { where };
  const term = str(params.q, 80);
  if (term) q.search = { term, fields: ['title', 'notes'] };
  return q;
}

async function getPlan(db, id) {
  const p = await db.get('workplans', id);
  if (!p) throw notFound('Work plan');
  return p;
}

const canEdit = (user, plan) => plan.status !== 'Closed' && (isAdmin(user) || plan.status === 'Draft');
const canUpdateProgress = (user, plan) => plan.status !== 'Closed';

function mustEdit(user, plan) {
  if (!canEdit(user, plan)) {
    throw forbidden(plan.status === 'Closed'
      ? 'This work plan is closed. An administrator can reopen it.'
      : 'This work plan is approved, so only an administrator can change it. Ask an administrator, or return it to draft first.');
  }
}

/**
 * Save a change to a plan. `change` receives the latest copy and returns the new one. If a colleague
 * saves the plan in between, the change is applied again to a fresh copy, so two people updating
 * different activities at the same moment never overwrite each other. With `ifMatch` (the version
 * the person read) the save is refused with 412 instead when the plan has changed since.
 */
async function savePlan(db, plan, change, { ifMatch } = {}) {
  let current = plan;
  for (let attempt = 1; ; attempt += 1) {
    if (ifMatch && current._etag !== ifMatch) throw changedMeanwhile();
    const next = { ...change(current), updatedAt: now() };
    try {
      return await db.replace('workplans', next, { ifMatch: current._etag });
    } catch (err) {
      if (err.code !== 412 || ifMatch || attempt >= 3) throw err;
      current = await getPlan(db, plan.id);
    }
  }
}

/** Keep activity reports when their plan or activity is removed: only the link is cleared. */
async function unlinkReports(db, where) {
  const linked = await db.find('reports', { where, fields: ['id'] });
  for (const { id } of linked) {
    for (let attempt = 1; ; attempt += 1) {
      const r = await db.get('reports', id);
      if (!r) break;
      try {
        await db.replace('reports', { ...r, workplanId: '', workplanItemId: '', updatedAt: now() }, { ifMatch: r._etag });
        break;
      } catch (err) {
        if (err.code !== 412 || attempt >= 3) throw err;
      }
    }
  }
  return linked.length;
}

async function createPlan(req, v, items = []) {
  const doc = {
    id: newId(), ...v, preparedById: v.preparedById || req.user.id, status: 'Draft', items,
    createdBy: req.user.id, createdAt: now(), updatedAt: now(),
  };
  const saved = await req.db.create('workplans', doc);
  audit(req, 'create', 'workplans', doc.id, `Created work plan "${doc.title}"`);
  return saved;
}

// Moving activities with the plan when its period changes, for example after copying last quarter's plan.
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Move a YYYY-MM-DD date by whole months (keeping the day, or the month's last day) or by days. */
function shiftDate(date, { months, days }) {
  if (months !== null) {
    const [y, m, d] = date.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = total - ny * 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ymd(ny, nm + 1, Math.min(d, last));
  }
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * Activities follow the start of the plan: by whole months when the old and new start fall on the same
 * day of the month (1 January to 1 April is three months), otherwise by days. A date that would still
 * fall outside the new period becomes its first or last day.
 */
function moveItems(items, from, to) {
  const [fy, fm, fd] = from.periodStart.split('-').map(Number);
  const [ty, tm, td] = to.periodStart.split('-').map(Number);
  const step = fd === td
    ? { months: (ty * 12 + tm) - (fy * 12 + fm), days: 0 }
    : { months: null, days: daysBetween(from.periodStart, to.periodStart) };
  const fit = (d) => {
    if (d < to.periodStart) return to.periodStart;
    if (d > to.periodEnd) return to.periodEnd;
    return d;
  };
  const move = (d) => (d ? fit(shiftDate(d, step)) : d);
  return (items || []).map((it) => ({ ...it, startDate: move(it.startDate), endDate: move(it.endDate) }));
}

async function updatePlan(req, plan, v, { ifMatch, moveActivities = false } = {}) {
  mustEdit(req.user, plan);
  let moved = 0;
  const saved = await savePlan(req.db, plan, (cur) => {
    mustEdit(req.user, cur);
    let items = cur.items || [];
    if (movesActivities(cur, v, moveActivities)) {
      items = moveItems(items, cur, v);
      moved = items.length;
    } else {
      const outside = outsidePeriod(items, v);
      if (outside.length) throw invalid({ periodEnd: outsideMessage(outside.length) });
    }
    return { ...cur, ...v, items };
  }, { ifMatch });
  audit(req, 'update', 'workplans', plan.id, `Updated work plan "${saved.title}"${moved ? ` (${moved} activity dates moved with the period)` : ''}`);
  return saved;
}

/** Administrators move a plan between Draft, Approved and Closed. */
async function setPlanStatus(req, plan, status, { ifMatch } = {}) {
  if (!isAdmin(req.user)) throw forbidden('Only an administrator can approve, close or reopen a work plan.');
  if (!choices.workplanStatuses.includes(status)) throw invalid({ status: 'Choose Draft, Approved or Closed.' });
  if (plan.status === status) return plan;
  const from = plan.status;
  const saved = await savePlan(req.db, plan, (cur) => {
    if (status === 'Approved' && !(cur.items || []).length) throw invalid({ status: 'Add at least one planned activity before approving the plan.' });
    const stamp = { closedAt: status === 'Closed' ? now() : '' };
    // Reopening a closed plan keeps the original approval; returning it to draft clears it.
    if (status === 'Approved' && !cur.approvedAt) Object.assign(stamp, { approvedById: req.user.id, approvedAt: now() });
    if (status === 'Draft') Object.assign(stamp, { approvedById: '', approvedAt: '' });
    return { ...cur, ...stamp, status };
  }, { ifMatch });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": ${from} to ${status}`);
  return saved;
}

/** Start a new draft from an existing plan: same activities, progress reset, no reports linked. */
async function copyPlan(req, plan) {
  const items = (plan.items || []).map((it) => ({ ...it, id: newId(), status: 'Not started', updatedAt: now() }));
  const v = { ...readPlan(plan), title: `Copy of ${plan.title}`.slice(0, 200), preparedById: req.user.id };
  return createPlan(req, v, items);
}

/** Delete a plan. Activity reports linked to it are kept and simply unlinked. */
async function deletePlan(req, plan) {
  if (!isAdmin(req.user)) throw forbidden('Only an administrator can delete a work plan.');
  await req.db.remove('workplans', plan.id);
  const unlinked = await unlinkReports(req.db, { workplanId: plan.id });
  audit(req, 'delete', 'workplans', plan.id, `Deleted work plan "${plan.title}" (${unlinked} reports unlinked)`);
  return { unlinked };
}

// ---------- Planned activities ----------
function readActivity(body) {
  return {
    number: intOrNull(body.number),
    title: str(body.title, 300),
    activityType: str(body.activityType),
    district: str(body.district),
    responsibleId: str(body.responsibleId),
    startDate: str(body.startDate, 10),
    endDate: str(body.endDate, 10),
    targetEvents: intOrNull(body.targetEvents),
    targetPeople: intOrNull(body.targetPeople),
    budget: amountOrNull(body.budget),
    output: str(body.output, 1000),
    status: str(body.status) || 'Not started',
  };
}

const numberTaken = (plan, number, itemId = null) => number !== null && (plan.items || []).some((it) => it.id !== itemId && it.number === number);
const takenMessage = (n) => `Activity number ${n} is already used in this plan.`;

async function validateActivity(db, plan, v, itemId = null) {
  const e = {};
  if (!v.title) e.title = 'Describe the activity.';
  if (Number.isNaN(v.number) || (v.number !== null && v.number < 0)) e.number = 'Enter a whole number.';
  else if (numberTaken(plan, v.number, itemId)) e.number = takenMessage(v.number);
  if (v.activityType && !choices.activities.includes(v.activityType)) e.activityType = 'Select a valid type of activity.';
  if (v.district && !choices.districts.includes(v.district)) e.district = 'Select a valid district.';
  if (v.responsibleId && !(await db.get('users', v.responsibleId))) e.responsibleId = 'Select a valid colleague.';
  for (const f of ['startDate', 'endDate']) {
    if (v[f] && !isRealDate(v[f])) e[f] = 'Enter a valid date.';
    else if (v[f] && (v[f] < plan.periodStart || v[f] > plan.periodEnd)) e[f] = `Choose a date within the plan period (${plan.periodStart} to ${plan.periodEnd}).`;
  }
  if (!e.startDate && !e.endDate && v.startDate && v.endDate && v.endDate < v.startDate) e.endDate = 'The end must be on or after the start.';
  if (Number.isNaN(v.targetEvents) || (v.targetEvents !== null && v.targetEvents < 0)) e.targetEvents = 'Enter a whole number.';
  if (Number.isNaN(v.targetPeople) || (v.targetPeople !== null && v.targetPeople < 0)) e.targetPeople = 'Enter a whole number.';
  if (Number.isNaN(v.budget) || (v.budget !== null && v.budget < 0)) e.budget = 'Enter a valid amount.';
  if (!choices.workplanActivityStatuses.includes(v.status)) e.status = 'Select a valid status.';
  return e;
}

const nextNumber = (plan) => (plan.items || []).reduce((m, it) => Math.max(m, Number.isInteger(it.number) ? it.number : 0), 0) + 1;
const sortItems = (items) => [...items].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || String(a.startDate).localeCompare(String(b.startDate)));

function getItem(plan, itemId) {
  const it = (plan.items || []).find((x) => x.id === itemId);
  if (!it) throw notFound('Planned activity');
  return it;
}

/** Dates are checked against the plan read before saving; this repeats the checks that a colleague's save could change. */
function recheck(cur, v, itemId) {
  if (numberTaken(cur, v.number, itemId)) throw invalid({ number: takenMessage(v.number) });
  for (const f of ['startDate', 'endDate']) {
    if (v[f] && (v[f] < cur.periodStart || v[f] > cur.periodEnd)) throw invalid({ [f]: `Choose a date within the plan period (${cur.periodStart} to ${cur.periodEnd}).` });
  }
}

async function addActivity(req, plan, v, { ifMatch } = {}) {
  mustEdit(req.user, plan);
  const item = { id: newId(), ...v };
  const saved = await savePlan(req.db, plan, (cur) => {
    mustEdit(req.user, cur);
    recheck(cur, v, null);
    Object.assign(item, { number: v.number ?? nextNumber(cur), updatedAt: now() });
    return { ...cur, items: sortItems([...(cur.items || []), item]) };
  }, { ifMatch });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": added activity ${item.number}. ${item.title}`);
  return { plan: saved, item };
}

/**
 * Change a planned activity. `version` is the activity's updatedAt when the form was opened: if a
 * colleague changed this activity since, the save is refused (412) rather than overwriting their change.
 */
async function updateActivity(req, plan, itemId, v, { ifMatch, version } = {}) {
  mustEdit(req.user, plan);
  getItem(plan, itemId);
  let item;
  const saved = await savePlan(req.db, plan, (cur) => {
    mustEdit(req.user, cur);
    const old = getItem(cur, itemId);
    if (version && old.updatedAt !== version) throw changedMeanwhile();
    recheck(cur, v, itemId);
    item = { ...old, ...v, number: v.number ?? old.number, updatedAt: now() };
    return { ...cur, items: sortItems(cur.items.map((it) => (it.id === itemId ? item : it))) };
  }, { ifMatch });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": changed activity ${item.number}. ${item.title}`);
  return { plan: saved, item };
}

/** Progress update: anyone may change the status of an activity while the plan is not closed. */
async function setActivityStatus(req, plan, itemId, status, { ifMatch } = {}) {
  const closed = () => forbidden('This work plan is closed. An administrator can reopen it.');
  if (!canUpdateProgress(req.user, plan)) throw closed();
  if (!choices.workplanActivityStatuses.includes(status)) throw invalid({ status: 'Select a valid status.' });
  const old = getItem(plan, itemId);
  if (old.status === status) return { plan, item: old };
  let item;
  const saved = await savePlan(req.db, plan, (cur) => {
    if (!canUpdateProgress(req.user, cur)) throw closed();
    item = { ...getItem(cur, itemId), status, updatedAt: now() };
    return { ...cur, items: cur.items.map((it) => (it.id === itemId ? item : it)) };
  }, { ifMatch });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": activity ${old.number}. ${old.title} set to ${status}`);
  return { plan: saved, item };
}

async function deleteActivity(req, plan, itemId, { ifMatch } = {}) {
  mustEdit(req.user, plan);
  const old = getItem(plan, itemId);
  const saved = await savePlan(req.db, plan, (cur) => {
    mustEdit(req.user, cur);
    getItem(cur, itemId);
    return { ...cur, items: cur.items.filter((it) => it.id !== itemId) };
  }, { ifMatch });
  const unlinked = await unlinkReports(req.db, { workplanId: plan.id, workplanItemId: itemId });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": removed activity ${old.number}. ${old.title} (${unlinked} reports unlinked)`);
  return { plan: saved, unlinked };
}

// ---------- Planned against achieved ----------
const REPORT_FIELDS = ['id', 'heading', 'date', 'workplanId', 'workplanItemId', 'attendeeIds', 'otherParticipants'];

/**
 * Linked activity reports give what was delivered: each report counts as one event, and the people
 * reached are its registered attendees plus the head count of others. Pass `reports` when they are
 * already loaded (the list page loads them for all plans at once).
 */
async function progress(db, plan, t0 = today(), reports = null) {
  const linked = reports || await db.find('reports', { where: { workplanId: plan.id }, fields: REPORT_FIELDS, orderBy: ['date', 'ASC'] });
  const items = sortItems(plan.items || []).map((it) => {
    const mine = linked.filter((r) => r.workplanItemId === it.id);
    const reached = mine.reduce((n, r) => n + (r.attendeeIds || []).length + (r.otherParticipants || 0), 0);
    const delivered = mine.length;
    const eventsPct = it.targetEvents ? Math.min(100, Math.round((delivered / it.targetEvents) * 100)) : null;
    return {
      ...it,
      reports: mine,
      delivered,
      reached,
      eventsPct,
      overdue: Boolean(it.endDate && it.endDate < t0 && !DONE.includes(it.status)),
    };
  });
  const active = items.filter((it) => it.status !== 'Cancelled');
  const sum = (list, f) => list.reduce((n, it) => n + (Number(it[f]) || 0), 0);
  const totals = {
    activities: items.length,
    completed: items.filter((it) => it.status === 'Completed').length,
    cancelled: items.length - active.length,
    overdue: items.filter((it) => it.overdue).length,
    targetEvents: sum(active, 'targetEvents'),
    delivered: sum(active, 'delivered'),
    targetPeople: sum(active, 'targetPeople'),
    reached: sum(active, 'reached'),
    budget: sum(active, 'budget'),
    reports: items.reduce((n, it) => n + it.reports.length, 0),
  };
  totals.completedPct = active.length ? Math.round((totals.completed / active.length) * 100) : 0;
  totals.eventsPct = totals.targetEvents ? Math.min(100, Math.round((totals.delivered / totals.targetEvents) * 100)) : null;
  totals.peoplePct = totals.targetPeople ? Math.min(100, Math.round((totals.reached / totals.targetPeople) * 100)) : null;
  return { items, totals };
}

/** Totals for several plans with one query for their reports: { planId: totals }. */
async function totalsFor(db, plans, t0 = today()) {
  const ids = plans.map((p) => p.id);
  const reports = [];
  for (let i = 0; i < ids.length; i += 100) {
    reports.push(...await db.find('reports', { where: { workplanId: { $in: ids.slice(i, i + 100) } }, fields: REPORT_FIELDS }));
  }
  const out = {};
  for (const p of plans) out[p.id] = (await progress(db, p, t0, reports.filter((r) => r.workplanId === p.id))).totals;
  return out;
}

/** Planned activities a report can be linked to (plans that are not closed, plus the current link). */
async function activityOptions(db, current = {}) {
  const plans = await db.find('workplans', { fields: ['id', 'title', 'status', 'items', 'periodStart', 'projectId'], orderBy: ['periodStart', 'DESC'] });
  const out = [];
  for (const p of plans) {
    for (const it of sortItems(p.items || [])) {
      const isCurrent = current.workplanId === p.id && current.workplanItemId === it.id;
      if (p.status === 'Closed' && !isCurrent) continue;
      out.push({
        value: `${p.id}:${it.id}`,
        label: `${p.title} · ${Number.isInteger(it.number) ? `${it.number}. ` : ''}${it.title}`,
        item: it,
        plan: p,
      });
    }
  }
  return out;
}

/** Activities a colleague is responsible for that are due within `days` or overdue (dashboard). */
async function dueFor(db, userId, days = 30) {
  const plans = await db.find('workplans', { where: { status: { $in: ['Draft', 'Approved'] } }, fields: ['id', 'title', 'items'] });
  const limit = today(days);
  const t0 = today();
  const rows = [];
  for (const p of plans) {
    for (const it of p.items || []) {
      if (it.responsibleId !== userId || DONE.includes(it.status) || !it.endDate || it.endDate > limit) continue;
      rows.push({ plan: p, item: it, overdue: it.endDate < t0 });
    }
  }
  return rows.sort((a, b) => a.item.endDate.localeCompare(b.item.endDate)).slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Display helpers for the pages: tag colours (always shown with the word), amounts and dates. */
const view = {
  planBadge: (s) => ({ Draft: 'tag-muted', Approved: '', Closed: 'tag-dark' }[s] ?? 'tag-muted'),
  actBadge: (s) => ({
    'Not started': 'tag-muted', 'In progress': '', Completed: 'tag-done', Postponed: 'tag-warn', Cancelled: 'tag-muted tag-strike',
  }[s] ?? 'tag-muted'),
  money: (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 })),
  /** "05 Oct" (or "05 Oct 2026"), read straight from YYYY-MM-DD so no time zone can shift the day. */
  day: (d, withYear = false) => {
    if (!isRealDate(d)) return d || '';
    const [y, m, dd] = d.split('-');
    return `${dd} ${MONTHS[Number(m) - 1]}${withYear ? ` ${y}` : ''}`;
  },
  /** When an activity takes place; the year is left out when the whole plan is within one year. */
  span: (it, plan) => {
    const withYear = String(plan.periodStart).slice(0, 4) !== String(plan.periodEnd).slice(0, 4);
    const f = (d) => view.day(d, withYear);
    if (it.startDate && it.endDate) return it.startDate === it.endDate ? f(it.startDate) : `${f(it.startDate)} to ${f(it.endDate)}`;
    if (it.endDate) return `By ${f(it.endDate)}`;
    if (it.startDate) return `From ${f(it.startDate)}`;
    return 'No dates set';
  },
};

/** People named on a plan, for display. */
const planUsers = (db, plan) => mapByIds(db, 'users', [plan.preparedById, plan.approvedById, ...(plan.items || []).map((it) => it.responsibleId)]);

module.exports = {
  DONE, readPlan, validatePlan, planQuery, getPlan, canEdit, canUpdateProgress, createPlan, updatePlan, setPlanStatus,
  copyPlan, deletePlan, readActivity, validateActivity, nextNumber, getItem, addActivity, updateActivity,
  setActivityStatus, deleteActivity, progress, totalsFor, activityOptions, dueFor, planUsers, view, moveItems,
};
