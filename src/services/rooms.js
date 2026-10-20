'use strict';
// Consultation rooms: staff discuss a case or a question. Only members (and administrators) can see a room.
// Shared by the web pages and the API.
const { audit } = require('../audit');
const { canSeeCase, isAdmin } = require('../access');
const { newId, now, str } = require('../helpers');
const { HttpError, notFound, forbidden } = require('./errors');

const canSeeRoom = (room, user) => isAdmin(user) || (room.memberIds || []).includes(user.id);

function roomQuery(user) {
  return { where: isAdmin(user) ? {} : { memberIds: { $contains: user.id } } };
}

async function getRoom(req, id) {
  const room = await req.db.get('rooms', id);
  if (!room) throw notFound('Room');
  if (!canSeeRoom(room, req.user)) throw forbidden('You are not a member of this room.');
  return room;
}

function readRoom(body) {
  return { name: str(body.name, 100), description: str(body.description, 2000), caseId: str(body.caseId) };
}

async function validateRoom(req, v) {
  const errors = {};
  if (!v.name) errors.name = 'Enter a topic for the room.';
  if (v.caseId) {
    const kase = await req.db.get('cases', v.caseId);
    if (!kase || !canSeeCase(req.user, kase)) errors.caseId = 'Select a valid case.';
  }
  return errors;
}

async function createRoom(req, v) {
  const doc = {
    id: newId(), ...v, memberIds: [req.user.id], createdBy: req.user.id, createdAt: now(), lastMessageAt: now(),
  };
  const saved = await req.db.create('rooms', doc);
  audit(req, 'create', 'rooms', doc.id, `Created room "${doc.name}"`);
  return saved;
}

/**
 * Messages in a room, oldest first. Without "after" this is the latest `limit` messages;
 * with "after" (an ISO time) it is only the messages posted since then, for live updates.
 */
async function listMessages(db, room, { after = '', limit = 500 } = {}) {
  const since = str(after, 40);
  if (!since) {
    const latest = await db.find('messages', { where: { roomId: room.id }, orderBy: ['createdAt', 'DESC'], limit });
    return latest.reverse();
  }
  const rows = await db.find('messages', { where: { roomId: room.id, createdAt: { $gte: since } }, orderBy: ['createdAt', 'ASC'], limit });
  return rows.filter((m) => m.createdAt > since);
}

async function postMessage(req, room, content) {
  const text = str(content, 4000);
  if (!text) throw new HttpError(422, 'validation_failed', 'Write a message.', { fields: { content: 'Write a message.' } });
  const at = now();
  const msg = { id: newId(), roomId: room.id, senderId: req.user.id, content: text, createdAt: at };
  await req.db.create('messages', msg);
  await req.db.replace('rooms', { ...room, lastMessageAt: at });
  return msg;
}

/** Add a colleague. Returns the user added, or null when they were already a member. */
async function addMember(req, room, userId) {
  const u = userId ? await req.db.get('users', str(userId)) : null;
  if (!u || u.active === false) throw new HttpError(422, 'validation_failed', 'Select a colleague to add.', { fields: { userId: 'Select a colleague to add.' } });
  if ((room.memberIds || []).includes(u.id)) return { user: u, added: false };
  await req.db.replace('rooms', { ...room, memberIds: [...(room.memberIds || []), u.id] });
  audit(req, 'update', 'rooms', room.id, `Added ${u.username} to room "${room.name}"`);
  return { user: u, added: true };
}

async function leaveRoom(req, room) {
  await req.db.replace('rooms', { ...room, memberIds: (room.memberIds || []).filter((id) => id !== req.user.id) });
}

async function deleteRoom(req, room) {
  if (!isAdmin(req.user) && room.createdBy !== req.user.id) throw forbidden('Only the creator or an administrator can delete a room.');
  const msgs = await req.db.find('messages', { where: { roomId: room.id }, fields: ['id'] });
  for (const m of msgs) await req.db.remove('messages', m.id, room.id);
  await req.db.remove('rooms', room.id);
  audit(req, 'delete', 'rooms', room.id, `Deleted room "${room.name}" and ${msgs.length} messages`);
}

module.exports = {
  canSeeRoom, roomQuery, getRoom, readRoom, validateRoom, createRoom, listMessages, postMessage, addMember, leaveRoom, deleteRoom,
};
