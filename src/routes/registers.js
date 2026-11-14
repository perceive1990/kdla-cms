'use strict';
// One place for attendance registers: every planned activity with its register reference, who is invited
// and confirmed, and what is still to do for each session (print, write the report with the names, record
// who came, upload the signed scans, approval). Activity reports outside a work plan are listed too.
const express = require('express');
const choices = require('../choices');
const reg = require('../registers');
const reports = require('../services/reports');
const attendance = require('../services/attendance');
const attStatus = require('../attendance-status');
const { str, mapByIds } = require('../helpers');

const router = express.Router();

const STEPS = {
  none: { label: 'Report not written', cls: 'tag-muted' },
  Draft: { label: 'Names to confirm and scans to upload', cls: 'tag-warn' },
  Returned: { label: 'Returned for correction', cls: 'tag-danger' },
  Submitted: { label: 'Waiting for approval', cls: '' },
  Approved: { label: 'Approved', cls: 'tag-done' },
};
const STEP_FILTERS = [['todo', 'Needs action'], ['none', 'Report not written'], ['Draft', 'Not submitted'], ['Returned', 'Returned'], ['Submitted', 'Waiting for approval'], ['Approved', 'Approved'], ['all', 'All']];

router.get('/', async (req, res) => {
  const user = req.user;
  const q = {
    office: choices.offices.includes(req.query.office) ? req.query.office : (req.query.office === undefined && !reports.allOffices(user) ? user.office || '' : ''),
    step: STEP_FILTERS.some(([v]) => v === req.query.step) ? req.query.step : 'todo',
    q: str(req.query.q, 80).toLowerCase(),
    closed: req.query.closed === '1',
  };
  const plans = (await req.db.find('workplans', { fields: ['id', 'title', 'office', 'status', 'periodStart', 'periodEnd', 'items'] }))
    .filter((p) => (q.closed || p.status !== 'Closed') && (!q.office || p.office === q.office));
  const planIds = plans.map((p) => p.id);
  const reps = [];
  for (let i = 0; i < planIds.length; i += 100) {
    reps.push(...await req.db.find('reports', {
      where: { workplanId: { $in: planIds.slice(i, i + 100) } },
      fields: ['id', 'heading', 'date', 'office', 'workplanId', 'workplanItemId', 'attendeeIds', 'otherParticipants', 'attendanceStatus', 'attachments'],
    }));
  }
  const loose = (await req.db.find('reports', {
    where: { attendanceStatus: { $in: ['Draft', 'Returned', 'Submitted'] } },
    fields: ['id', 'heading', 'date', 'office', 'workplanId', 'workplanItemId', 'attendeeIds', 'otherParticipants', 'attendanceStatus', 'attachments'],
  })).filter((r) => !r.workplanId && (!q.office || r.office === q.office));

  const session = (r) => ({
    id: r.id, heading: r.heading, date: r.date, status: attStatus.statusOf(r), attended: (r.attendeeIds || []).length + (r.otherParticipants || 0), scans: attendance.registerFiles(r).length,
  });
  let rows = [];
  for (const plan of plans) {
    for (const item of plan.items || []) {
      if (item.status === 'Cancelled') continue;
      const sessions = reps.filter((r) => r.workplanId === plan.id && r.workplanItemId === item.id).map(session).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const listed = new Set(item.shortlist || []);
      const confirmed = Object.entries(item.confirmations || {}).filter(([id, v]) => v === 'yes' && listed.has(id)).length;
      const steps = sessions.length ? sessions.map((s) => s.status) : ['none'];
      rows.push({
        plan, item, code: reg.planCode(plan, item), sessions, invited: listed.size, confirmed, steps, canReport: reports.canWriteFor(user, plan.office || ''),
      });
    }
  }
  const match = (r) => {
    if (q.q && !`${r.code} ${r.item.title} ${r.plan.title} ${r.item.venue || ''}`.toLowerCase().includes(q.q)) return false;
    if (q.step === 'all') return true;
    if (q.step === 'todo') return r.steps.some((s) => s !== 'Approved' && s !== 'Submitted');
    return r.steps.includes(q.step);
  };
  rows = rows.filter(match).sort((a, b) => String(a.item.startDate || a.plan.periodStart).localeCompare(String(b.item.startDate || b.plan.periodStart)));
  const looseRows = loose.filter((r) => !q.q || r.heading.toLowerCase().includes(q.q))
    .map((r) => ({ ...session(r), code: reg.reportCode(r, null, null, r.office), office: r.office }))
    .filter((r) => q.step === 'all' || q.step === 'todo' || r.status === q.step);
  const users = await mapByIds(req.db, 'users', rows.map((r) => r.item.responsibleId).filter(Boolean));
  res.render('registers', {
    title: 'Registers', rows, looseRows, q, STEPS, STEP_FILTERS, users,
  });
});

module.exports = router;
