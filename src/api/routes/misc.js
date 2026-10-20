'use strict';
// Drop-down lists, statistics, search, consultation rooms, and the administrator's audit trail and export.
const express = require('express');
const choices = require('../../choices');
const { period, compute } = require('../../services/stats');
const { searchAll } = require('../../services/search');
const rooms = require('../../services/rooms');
const adm = require('../../services/admin');
const { audit } = require('../../audit');
const { mapByIds, isRealDate } = require('../../helpers');
const { adminOnly } = require('../auth');
const h = require('../http');

const router = express.Router();

/** Every option list used in forms (case types, statuses, offices and so on). */
router.get('/choices', (req, res) => res.json(choices));

/** Figures for a period, disaggregated the same way as the Statistics page. */
router.get('/statistics', async (req, res) => {
  for (const f of ['from', 'to']) if (req.query[f] && !isRealDate(req.query[f])) throw h.invalid({ [f]: 'Use a date written YYYY-MM-DD.' });
  const p = period(req.query);
  if (p.from > p.to) throw h.invalid({ to: 'The end date must be on or after the start date.' });
  audit(req, 'view', 'statistics', null, `Statistics ${p.from} to ${p.to} (API)`);
  res.json({ period: p, ...(await compute(req.db, p)) });
});

router.get('/search', async (req, res) => {
  const r = await searchAll(req, req.query.q);
  if (r.term.length < 2) throw h.invalid({ q: 'Search for at least 2 characters.' });
  res.json({
    term: r.term,
    cases: r.cases.map((c) => ({
      id: c.id, caseNumber: c.caseNumber, heading: c.heading, status: c.status, openedOn: c.openedOn,
    })),
    people: r.people.map((p) => ({
      id: p.id, kind: p.kind, firstName: p.firstName, lastName: p.lastName, nrc: p.nrc || '', caseNumber: p.caseNumber || '',
    })),
    reports: r.reports.map((x) => ({
      id: x.id, heading: x.heading, date: x.date, activityType: x.activityType, district: x.district,
    })),
    stakeholders: r.orgs.map((s) => ({ id: s.id, name: s.name, contactPerson: s.contactPerson, phone: s.phone })),
  });
});

// ---------- Consultation rooms ----------
router.get('/rooms', async (req, res) => {
  const list = await req.db.find('rooms', { ...rooms.roomQuery(req.user), orderBy: ['lastMessageAt', 'DESC'] });
  res.json({ data: list.map((r) => h.present(r)) });
});

router.post('/rooms', async (req, res) => {
  const v = rooms.readRoom(req.body);
  h.failIfInvalid(await rooms.validateRoom(req, v));
  const doc = await rooms.createRoom(req, v);
  h.sendOne(res, h.present(doc), 201, `${h.BASE}/rooms/${doc.id}`);
});

router.get('/rooms/:id', async (req, res) => {
  h.sendOne(res, h.present(await rooms.getRoom(req, req.params.id)));
});

router.delete('/rooms/:id', async (req, res) => {
  await rooms.deleteRoom(req, await rooms.getRoom(req, req.params.id));
  res.status(204).end();
});

/** Messages, oldest first. Pass ?after=<createdAt of the last message you have> to get only new ones. */
router.get('/rooms/:id/messages', async (req, res) => {
  const room = await rooms.getRoom(req, req.params.id);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const messages = await rooms.listMessages(req.db, room, { after: req.query.after, limit });
  const users = await mapByIds(req.db, 'users', messages.map((m) => m.senderId));
  res.json({
    data: messages.map((m) => ({
      ...h.present(m),
      senderName: users[m.senderId] ? users[m.senderId].fullName || users[m.senderId].username : 'Former user',
      mine: m.senderId === req.user.id,
    })),
  });
});

router.post('/rooms/:id/messages', async (req, res) => {
  const room = await rooms.getRoom(req, req.params.id);
  const msg = await rooms.postMessage(req, room, req.body.content);
  res.status(201).json(h.present(msg));
});

router.post('/rooms/:id/members', async (req, res) => {
  const room = await rooms.getRoom(req, req.params.id);
  const { added } = await rooms.addMember(req, room, req.body.userId);
  res.json({ ...h.present(await rooms.getRoom(req, room.id)), added });
});

router.post('/rooms/:id/leave', async (req, res) => {
  await rooms.leaveRoom(req, await rooms.getRoom(req, req.params.id));
  res.status(204).end();
});

// ---------- Administration ----------
router.get('/audit', adminOnly, async (req, res) => {
  const { rows, meta } = await h.findPage(req, 'audit', adm.auditQuery(req.query), ['at', 'DESC']);
  h.sendList(res, rows.map((e) => h.present(e)), meta);
});

/** Every record except passwords, two-step secrets and API tokens, as one JSON document. */
router.get('/export', adminOnly, async (req, res) => {
  res.json(await adm.exportAll(req));
});

module.exports = router;
