'use strict';
// Rules for case files, shared by the web pages and the API.
const choices = require('../choices');
const config = require('../config');
const { audit } = require('../audit');
const { visibleWhere, canSeeCase, isAdmin } = require('../access');
const {
  newId, now, arr, str, bool, intOrNull, mapByIds, today, isRealDate,
} = require('../helpers');
const { removeAttachments } = require('./attachments');
const { HttpError, notFound, forbidden } = require('./errors');

const isConcluded = (s) => String(s || '').startsWith('Concluded');

/** Turn submitted fields (form or JSON) into a clean case record. */
function readCase(body) {
  const v = {
    heading: str(body.heading, 300),
    openedOn: str(body.openedOn, 10),
    caseTypes: arr(body.caseTypes).filter((t) => choices.caseTypes.includes(t)),
    services: arr(body.services).filter((t) => choices.legalServices.includes(t)),
    complaint: str(body.complaint, 4000),
    defence: str(body.defence, 4000),
    actionTaken: str(body.actionTaken, 4000),
    status: str(body.status),
    officerId: str(body.officerId),
    teamIds: arr(body.teamIds),
    clientIds: arr(body.clientIds),
    defendantIds: arr(body.defendantIds),
    office: str(body.office),
    restricted: bool(body.restricted),
    outcome: str(body.outcome),
    outcomeNotes: str(body.outcomeNotes, 2000),
    closedOn: str(body.closedOn, 10),
  };
  v.teamIds = [...new Set(v.teamIds.filter((id) => id !== v.officerId))];
  v.clientIds = [...new Set(v.clientIds)];
  v.defendantIds = [...new Set(v.defendantIds)];
  if (!isConcluded(v.status)) {
    v.outcome = '';
    v.outcomeNotes = '';
    v.closedOn = '';
  } else if (!v.closedOn) {
    v.closedOn = today();
  }
  return v;
}

async function validateCase(db, v) {
  const e = {};
  if (!v.heading) e.heading = 'Enter a heading, for example "John Mansa vs Mary Sampa".';
  if (!isRealDate(v.openedOn)) e.openedOn = 'Enter the date the case was opened.';
  else if (v.openedOn > today()) e.openedOn = 'The opening date cannot be in the future.';
  if (!v.caseTypes.length) e.caseTypes = 'Select at least one type of case.';
  if (!v.services.length) e.services = 'Select at least one legal service offered.';
  if (!choices.caseStatuses.includes(v.status)) e.status = 'Select a status.';
  if (v.office && !choices.offices.includes(v.office)) e.office = 'Select a valid office.';
  if (!v.officerId || !(await db.get('users', v.officerId))) e.officerId = 'Select the responsible officer.';
  if (!v.clientIds.length) e.clientIds = 'Select at least one client (complainant).';
  const team = await mapByIds(db, 'users', v.teamIds);
  if (v.teamIds.some((id) => !team[id])) e.teamIds = 'One of the selected team members no longer exists.';
  if (isConcluded(v.status)) {
    if (!choices.caseOutcomes.includes(v.outcome)) e.outcome = 'Select the outcome of the case.';
    if (!isRealDate(v.closedOn)) e.closedOn = 'Enter the date the case was concluded.';
    else if (isRealDate(v.openedOn) && v.closedOn < v.openedOn) e.closedOn = 'The closing date cannot be before the opening date.';
  }
  const ppl = await mapByIds(db, 'people', [...v.clientIds, ...v.defendantIds]);
  if (v.clientIds.some((id) => !ppl[id] || ppl[id].kind !== 'client')) e.clientIds = 'One of the selected clients no longer exists.';
  if (v.defendantIds.some((id) => !ppl[id] || ppl[id].kind !== 'defendant')) e.defendantIds = 'One of the selected other parties no longer exists.';
  return e;
}

/** Search filters (from the web list or API query string), limited to cases the user may see. */
function caseQuery(user, params = {}) {
  const where = {};
  if (choices.caseStatuses.includes(params.status)) where.status = params.status;
  if (params.status === 'open') where.status = { $in: choices.caseStatuses.filter((s) => s.startsWith('Open')) };
  if (params.status === 'concluded') where.status = { $in: choices.caseStatuses.filter((s) => s.startsWith('Concluded')) };
  if (choices.offices.includes(params.office)) where.office = params.office;
  if (choices.caseTypes.includes(params.type)) where.caseTypes = { $contains: params.type };
  if (choices.caseOutcomes.includes(params.outcome)) where.outcome = params.outcome;
  if (params.officer === 'me') where.officerId = user.id;
  else if (params.officer) where.officerId = String(params.officer).slice(0, 60);
  if (params.client) where.clientIds = { $contains: String(params.client).slice(0, 60) };
  if (params.confidential === '1' || params.confidential === 'true') where.restricted = true;
  if (isRealDate(params.from)) where.openedOn = { $gte: params.from };
  if (isRealDate(params.to)) where.openedOn = { ...(where.openedOn || {}), $lte: params.to };
  const q = { where: visibleWhere(user, where) };
  const term = str(params.q, 80);
  if (term) q.search = { term, fields: ['heading', 'caseNumber', 'complaint'] };
  return q;
}

/** Load a case the user may open. Opening a confidential case without access is refused and logged. */
async function getCase(req, id) {
  const c = await req.db.get('cases', id);
  if (!c) throw notFound('Case');
  if (!canSeeCase(req.user, c)) {
    audit(req, 'view', 'cases', c.id, `Blocked: confidential case ${c.caseNumber}`);
    throw new HttpError(403, 'confidential', `Case ${c.caseNumber} is confidential. Only the responsible officer, the case team and administrators can open it.`);
  }
  return c;
}

function logView(req, c) {
  if (c.restricted) audit(req, 'view', 'cases', c.id, `Viewed confidential case ${c.caseNumber}`);
}

async function createCase(req, v, attachments = []) {
  const year = v.openedOn.slice(0, 4);
  const seq = await req.db.nextSequence(`case-${year}`);
  const at = now();
  const history = [{ at, by: req.user.id, action: 'Case opened', status: v.status }];
  if (v.restricted) history.push({ at, by: req.user.id, action: 'Marked confidential' });
  const doc = {
    id: newId(),
    caseNumber: `${config.orgName}/${year}/${String(seq).padStart(4, '0')}`,
    ...v,
    attachments,
    history,
    createdBy: req.user.id,
    createdAt: at,
    updatedAt: at,
  };
  const saved = await req.db.create('cases', doc);
  audit(req, 'create', 'cases', doc.id, `Opened case ${doc.caseNumber}${doc.restricted ? ' (confidential)' : ''}`);
  return saved;
}

/** Only the officer, an administrator or the creator may change who can see a confidential case. */
const mayChangeAccess = (user, c) => isAdmin(user) || c.officerId === user.id || c.createdBy === user.id;

function protectAccessFields(user, c, v) {
  if (!mayChangeAccess(user, c)) {
    v.restricted = c.restricted === true;
    v.teamIds = c.teamIds || [];
  }
  return v;
}

async function updateCase(req, c, v, { ifMatch, attachments = [] } = {}) {
  const history = [...(c.history || [])];
  const by = req.user.id;
  const at = now();
  let logged = false;
  if (v.status !== c.status) {
    history.push({ at, by, action: isConcluded(v.status) ? 'Case concluded' : 'Status changed', status: v.status, from: c.status });
    logged = true;
  }
  if (v.outcome && v.outcome !== c.outcome) { history.push({ at, by, action: 'Outcome recorded', status: v.outcome }); logged = true; }
  if (v.officerId !== c.officerId) {
    const u = await req.db.get('users', v.officerId);
    history.push({ at, by, action: 'Officer changed', status: u ? u.fullName || u.username : '' });
    logged = true;
  }
  if (v.restricted !== (c.restricted === true)) {
    history.push({ at, by, action: v.restricted ? 'Marked confidential' : 'Confidential marking removed' });
    logged = true;
  }
  if (!logged) history.push({ at, by, action: 'Record updated' });
  const updated = {
    ...c, ...v, history: history.slice(-200), attachments: [...(c.attachments || []), ...attachments], updatedAt: at,
  };
  const saved = await req.db.replace('cases', updated, { ifMatch });
  audit(req, 'update', 'cases', c.id, `Updated case ${c.caseNumber}${v.status !== c.status ? ` (status: ${v.status})` : ''}`);
  return saved;
}

async function deleteCase(req, c) {
  const [refs, notes, tasks, rooms] = await Promise.all([
    req.db.find('referrals', { where: { caseId: c.id }, fields: ['id'] }),
    req.db.find('caseNotes', { where: { caseId: c.id }, fields: ['id'] }),
    req.db.find('tasks', { where: { caseId: c.id }, fields: ['id'] }),
    req.db.find('rooms', { where: { caseId: c.id }, fields: ['id'] }),
  ]);
  // Case consultations belong to the case: their discussions go with it.
  for (const room of rooms) {
    const msgs = await req.db.find('messages', { where: { roomId: room.id }, fields: ['id'] });
    for (const m of msgs) await req.db.remove('messages', m.id, room.id);
    await req.db.remove('rooms', room.id);
  }
  for (const r of refs) await req.db.remove('referrals', r.id);
  for (const n of notes) await req.db.remove('caseNotes', n.id, c.id);
  for (const t of tasks) await req.db.remove('tasks', t.id);
  await removeAttachments(c.attachments);
  await req.db.remove('cases', c.id);
  audit(req, 'delete', 'cases', c.id, `Deleted case ${c.caseNumber} with ${refs.length} referrals, ${notes.length} notes, ${tasks.length} tasks, ${rooms.length} consultation rooms`);
}

// ---------- Case diary ----------
function readNote(body) {
  return {
    type: str(body.type),
    date: str(body.date, 10) || today(),
    minutes: intOrNull(body.minutes),
    text: str(body.text, 5000),
  };
}

function validateNote(n) {
  const e = {};
  if (!choices.noteTypes.includes(n.type)) e.type = 'Select the type of entry.';
  if (!isRealDate(n.date) || n.date > today()) e.date = 'Enter a valid date that is not in the future.';
  if (Number.isNaN(n.minutes) || (n.minutes !== null && (n.minutes < 0 || n.minutes > 24 * 60))) e.minutes = 'Time spent must be between 0 and 1440 minutes.';
  if (!n.text) e.text = 'Write what happened.';
  return e;
}

async function listNotes(db, c) {
  const notes = await db.find('caseNotes', { where: { caseId: c.id }, orderBy: ['date', 'DESC'] });
  return notes.sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}

async function addNote(req, c, n) {
  const note = { id: newId(), caseId: c.id, ...n, authorId: req.user.id, createdAt: now() };
  const saved = await req.db.create('caseNotes', note);
  await req.db.replace('cases', { ...c, updatedAt: now() });
  audit(req, 'create', 'caseNotes', note.id, `Added ${n.type.toLowerCase()} note to ${c.caseNumber}`);
  return saved;
}

async function deleteNote(req, c, noteId) {
  const note = await req.db.get('caseNotes', noteId, c.id);
  if (!note) throw notFound('Diary entry');
  if (note.authorId !== req.user.id && !isAdmin(req.user)) throw forbidden('Only the author or an administrator can delete a diary entry.');
  await req.db.remove('caseNotes', note.id, c.id);
  audit(req, 'delete', 'caseNotes', note.id, `Deleted note from ${c.caseNumber}`);
}

module.exports = {
  isConcluded, readCase, validateCase, caseQuery, getCase, logView, createCase, mayChangeAccess, protectAccessFields, updateCase, deleteCase,
  readNote, validateNote, listNotes, addNote, deleteNote,
};
