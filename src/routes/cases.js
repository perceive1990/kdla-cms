'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { checkCase } = require('../conflicts');
const svc = require('../services/cases');
const { saveUploads } = require('../services/attachments');
const {
  arr, mapByIds, pagination, toCsv, sendCsv, fullName, fmtDate, today, daysBetween,
} = require('../helpers');

const router = express.Router();

async function formLists(db) {
  const [clients, defendants, officers] = await Promise.all([
    db.find('people', { where: { kind: 'client' }, fields: ['id', 'firstName', 'lastName', 'caseNumber'], orderBy: ['lastName', 'ASC'] }),
    db.find('people', { where: { kind: 'defendant' }, fields: ['id', 'firstName', 'lastName'], orderBy: ['lastName', 'ASC'] }),
    db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] }),
  ]);
  return { clients, defendants, officers };
}

const uname = (users, id) => (users[id] ? users[id].fullName || users[id].username : '');

router.get('/', async (req, res) => {
  const q = svc.caseQuery(req.user, req.query);
  const total = await req.db.count('cases', q);
  const pg = pagination(req, total);
  const cases = await req.db.find('cases', { ...q, orderBy: ['updatedAt', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const people = await mapByIds(req.db, 'people', cases.flatMap((c) => [...(c.clientIds || []), ...(c.defendantIds || [])]));
  const officers = await req.db.find('users', { fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] });
  const users = Object.fromEntries(officers.map((u) => [u.id, u]));
  res.render('cases/list', { title: 'Cases', cases, people, users, officers, pg });
});

router.get('/export.csv', async (req, res) => {
  const cases = await req.db.find('cases', { ...svc.caseQuery(req.user, req.query), orderBy: ['openedOn', 'ASC'] });
  const people = await mapByIds(req.db, 'people', cases.flatMap((c) => [...(c.clientIds || []), ...(c.defendantIds || [])]));
  const users = await mapByIds(req.db, 'users', cases.map((c) => c.officerId));
  const names = (ids) => (ids || []).map((id) => fullName(people[id])).filter(Boolean);
  const csv = toCsv([
    { label: 'Case number', value: 'caseNumber' },
    { label: 'Date opened', value: 'openedOn' },
    { label: 'Heading', value: 'heading' },
    { label: 'Types of case', value: 'caseTypes' },
    { label: 'Services offered', value: 'services' },
    { label: 'Status', value: 'status' },
    { label: 'Outcome', value: 'outcome' },
    { label: 'Date concluded', value: 'closedOn' },
    { label: 'Days open', value: (c) => daysBetween(c.openedOn, c.closedOn || today()) },
    { label: 'Office', value: 'office' },
    { label: 'Officer', value: (c) => uname(users, c.officerId) },
    { label: 'Clients', value: (c) => names(c.clientIds) },
    { label: 'Client age categories', value: (c) => (c.clientIds || []).map((id) => people[id] && people[id].ageCategory).filter(Boolean) },
    { label: 'Other parties', value: (c) => names(c.defendantIds) },
    { label: 'Confidential', value: (c) => (c.restricted ? 'Yes' : 'No') },
    { label: 'Last updated', value: (c) => fmtDate(c.updatedAt) },
  ], cases);
  audit(req, 'export', 'cases', null, `Exported ${cases.length} cases to CSV`);
  sendCsv(res, `cases-${today()}.csv`, csv);
});

router.get('/new', async (req, res) => {
  const values = {
    status: 'Open Active Case', officerId: req.user.id, office: req.user.office || '', openedOn: today(),
    clientIds: arr(req.query.client), caseTypes: [], services: [], defendantIds: [], teamIds: [],
  };
  res.render('cases/form', { title: 'New case', values, errors: {}, isNew: true, ...(await formLists(req.db)) });
});

router.post('/', async (req, res) => {
  const v = svc.readCase(req.body);
  const errors = await svc.validateCase(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('cases/form', { title: 'New case', values: v, errors, isNew: true, ...(await formLists(req.db)) });
  }
  const doc = await svc.createCase(req, v, await saveUploads(req.files, req.user));
  req.flash('success', `Case ${doc.caseNumber} added.`);
  return res.redirect(`/cases/${doc.id}`);
});

router.get('/:id', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  svc.logView(req, c);
  const [people, referrals, notes, tasks] = await Promise.all([
    mapByIds(req.db, 'people', [...(c.clientIds || []), ...(c.defendantIds || [])]),
    req.db.find('referrals', { where: { caseId: c.id }, orderBy: ['createdAt', 'DESC'] }),
    svc.listNotes(req.db, c),
    req.db.find('tasks', { where: { caseId: c.id }, orderBy: ['dueDate', 'ASC'] }),
  ]);
  const userIds = [c.officerId, c.createdBy, ...(c.teamIds || []), ...(c.history || []).map((x) => x.by),
    ...(c.attachments || []).map((a) => a.uploadedBy), ...notes.map((n) => n.authorId), ...tasks.map((t) => t.assigneeId)];
  const [users, orgs, conflicts, staff] = await Promise.all([
    mapByIds(req.db, 'users', userIds),
    mapByIds(req.db, 'stakeholders', referrals.map((r) => r.organizationId)),
    checkCase(req.db, c, people),
    req.db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] }),
  ]);
  const minutes = notes.reduce((sum, n) => sum + (n.minutes || 0), 0);
  return res.render('cases/show', {
    title: c.heading, c, people, users, referrals, orgs, notes, tasks, conflicts, staff, minutes,
    daysOpen: daysBetween(c.openedOn, c.closedOn || today()),
    noteValues: { date: today(), type: 'Meeting with client' }, noteErrors: {},
  });
});

router.post('/:id/notes', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const n = svc.readNote(req.body);
  const errors = svc.validateNote(n);
  if (Object.keys(errors).length) {
    req.flash('danger', Object.values(errors).join(' '));
    return res.redirect(`/cases/${c.id}#notes`);
  }
  await svc.addNote(req, c, n);
  req.flash('success', 'Note added to the case diary.');
  return res.redirect(`/cases/${c.id}#notes`);
});

router.post('/:id/notes/:noteId/delete', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  await svc.deleteNote(req, c, req.params.noteId);
  req.flash('success', 'Note deleted.');
  return res.redirect(`/cases/${c.id}#notes`);
});

router.get('/:id/edit', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  return res.render('cases/form', { title: `Edit ${c.caseNumber}`, values: c, errors: {}, isNew: false, ...(await formLists(req.db)) });
});

router.post('/:id', async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  const v = svc.protectAccessFields(req.user, c, svc.readCase(req.body));
  const errors = await svc.validateCase(req.db, v);
  if (Object.keys(errors).length) {
    return res.status(400).render('cases/form', {
      title: `Edit ${c.caseNumber}`, values: { ...c, ...v }, errors, isNew: false, ...(await formLists(req.db)),
    });
  }
  await svc.updateCase(req, c, v, { ifMatch: req.body._etag, attachments: await saveUploads(req.files, req.user) });
  req.flash('success', 'Case updated.');
  return res.redirect(`/cases/${c.id}`);
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const c = await svc.getCase(req, req.params.id);
  await svc.deleteCase(req, c);
  req.flash('success', `Case ${c.caseNumber} deleted.`);
  return res.redirect('/cases');
});

module.exports = router;
