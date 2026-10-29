'use strict';
const express = require('express');
const { str, mapByIds, fmtDateTime } = require('../helpers');
const { visibleWhere, visibleCase, visibleMap } = require('../access');
const svc = require('../services/rooms');

const router = express.Router();

router.get('/', async (req, res) => {
  const all = await req.db.find('rooms', { ...svc.roomQuery(req.user), orderBy: ['lastMessageAt', 'DESC'] });
  const kind = svc.KINDS.some((k) => k.value === req.query.kind) ? req.query.kind : '';
  const rooms = kind ? all.filter((r) => svc.kindOf(r) === kind) : all;
  const counts = { all: all.length };
  for (const k of svc.KINDS) counts[k.value] = all.filter((r) => svc.kindOf(r) === k.value).length;
  const cases = visibleMap(req.user, await mapByIds(req.db, 'cases', rooms.map((r) => r.caseId).filter(Boolean)));
  res.render('rooms/list', {
    title: 'Consultation rooms', rooms, kind, kinds: svc.KINDS, kindOf: svc.kindOf, counts, cases,
  });
});

const caseOptions = (req) => req.db.find('cases', {
  where: visibleWhere(req.user, {}), fields: ['id', 'caseNumber', 'heading'], orderBy: ['updatedAt', 'DESC'],
});

router.get('/new', async (req, res) => {
  const cases = await caseOptions(req);
  const kind = req.query.kind === 'management' ? 'management' : 'case';
  res.render('rooms/form', {
    title: 'New consultation room', values: { kind, caseId: str(req.query.case) }, errors: {}, cases, kinds: svc.KINDS,
  });
});

router.post('/', async (req, res) => {
  const v = svc.readRoom(req.body);
  const errors = await svc.validateRoom(req, v);
  if (Object.keys(errors).length) {
    const cases = await caseOptions(req);
    return res.status(400).render('rooms/form', {
      title: 'New consultation room', values: v, errors, cases, kinds: svc.KINDS,
    });
  }
  const doc = await svc.createRoom(req, v);
  req.flash('success', 'Room created. Add colleagues so they can join the discussion.');
  return res.redirect(`/rooms/${doc.id}`);
});

router.get('/:id', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  const messages = await svc.listMessages(req.db, room);
  const users = await req.db.find('users', { where: { active: true }, fields: ['id', 'fullName', 'username'], orderBy: ['username', 'ASC'] });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  Object.assign(byId, await mapByIds(req.db, 'users', messages.map((m) => m.senderId).filter((id) => !byId[id])));
  const c = room.caseId ? visibleCase(req.user, await req.db.get('cases', room.caseId)) : null;
  res.render('rooms/show', {
    title: room.name, room, kind: svc.kindOf(room), messages, users: byId, nonMembers: users.filter((u) => !(room.memberIds || []).includes(u.id)), c,
  });
});

// JSON feed for live updates (polled by the page every few seconds).
router.get('/:id/messages.json', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  const messages = await svc.listMessages(req.db, room, { after: req.query.after, limit: 200 });
  const users = await mapByIds(req.db, 'users', messages.map((m) => m.senderId));
  res.json(messages.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    when: fmtDateTime(m.createdAt),
    content: m.content,
    sender: users[m.senderId] ? users[m.senderId].fullName || users[m.senderId].username : 'Former user',
    mine: m.senderId === req.user.id,
  })));
});

router.post('/:id/messages', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  if (str(req.body.content, 4000)) await svc.postMessage(req, room, req.body.content);
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
  return res.redirect(`/rooms/${room.id}#latest`);
});

router.post('/:id/members', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  try {
    const { user, added } = await svc.addMember(req, room, req.body.userId);
    if (added) req.flash('success', `${user.fullName || user.username} added to the room.`);
  } catch (e) {
    if (e.status !== 422) throw e;
    req.flash('danger', e.message);
  }
  return res.redirect(`/rooms/${room.id}`);
});

router.post('/:id/leave', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  await svc.leaveRoom(req, room);
  req.flash('success', `You left "${room.name}".`);
  return res.redirect('/rooms');
});

router.post('/:id/delete', async (req, res) => {
  const room = await svc.getRoom(req, req.params.id);
  await svc.deleteRoom(req, room);
  req.flash('success', 'Room deleted.');
  return res.redirect('/rooms');
});

module.exports = router;
