'use strict';
// Attendance from invitation to approval, shared by the web pages and the API.
//   1. Before the activity, staff of the office shortlist who to invite to a planned activity, importing
//      registered activity attendees by village or area. The register for signing prints their names.
//   2. After it, the activity report's attendance is corrected (who came, walk-ins, details), the signed
//      registers are uploaded, and the attendance is submitted.
//   3. An administrator approves it, or returns it for correction. Only approved attendance counts in
//      statistics, work plan progress and the logframe; it is then locked.
const { audit } = require('../audit');
const { mapByIds, now, str } = require('../helpers');
const { forbidden, notFound, HttpError } = require('./errors');
const reports = require('./reports');
const workplans = require('./workplans');

const {
  STATUSES, LABEL, statusOf, counts, locked,
} = require('../attendance-status');

const isAdmin = (user) => Boolean(user && user.role === 'admin');
const registerFiles = (r) => (r.attachments || []).filter((a) => a.register);
const areaKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

const conflict = (msg) => new HttpError(409, 'attendance_locked', msg);

// ---------- Shortlists on planned activities ----------

/** Villages and areas where activity attendees are registered, with how many in each. */
async function areas(db) {
  const people = await db.find('people', { where: { kind: 'attendee' }, fields: ['id', 'location'] });
  const out = new Map();
  for (const p of people) {
    const name = String(p.location || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const k = areaKey(name);
    const cur = out.get(k) || { name, count: 0 };
    cur.count += 1;
    out.set(k, cur);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mustShortlist(user, plan) {
  if (plan.status === 'Closed') throw forbidden('This work plan is closed. An administrator can reopen it.');
  reports.mustWriteFor(user, plan.office || '');
}

async function changeShortlist(req, plan, itemId, fn, text) {
  mustShortlist(req.user, plan);
  const before = workplans.getItem(plan, itemId);
  let item;
  await workplans.savePlan(req.db, plan, (cur) => {
    const it = workplans.getItem(cur, itemId);
    item = { ...it, shortlist: [...new Set(fn(it.shortlist || []))].slice(0, 1000), updatedAt: now() };
    return { ...cur, items: cur.items.map((x) => (x.id === itemId ? item : x)) };
  });
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": ${text} for activity ${before.number ?? ''} ${before.title}`.replace(/\s+/g, ' '));
  return item;
}

/** People already recorded at a session (activity report) of this planned activity: person id → report. */
const attendedActivity = (db, plan, item) => reports.onOtherRegisters(db, { workplanId: plan.id, workplanItemId: item.id || item });

/** Adds every registered activity attendee of the chosen villages or areas to the shortlist. */
async function importAreas(req, plan, itemId, chosen) {
  const want = new Set((Array.isArray(chosen) ? chosen : [chosen]).map(areaKey).filter(Boolean));
  if (!want.size) throw new HttpError(422, 'validation', 'Choose at least one village or area.', { fields: { areas: 'Choose at least one village or area.' } });
  const people = await req.db.find('people', { where: { kind: 'attendee' }, fields: ['id', 'location'] });
  const done = await attendedActivity(req.db, plan, itemId);
  const inArea = people.filter((p) => want.has(areaKey(p.location))).map((p) => p.id);
  // People already recorded at a session of this activity are not invited again.
  const ids = inArea.filter((id) => !done.has(id));
  let added = 0;
  const item = await changeShortlist(req, plan, itemId, (list) => {
    const have = new Set(list);
    added = ids.filter((id) => !have.has(id)).length;
    return [...list, ...ids];
  }, `shortlisted attendees from ${[...want].length} area(s)`);
  return {
    item, added, found: inArea.length, already: inArea.length - ids.length,
  };
}

async function addPeople(req, plan, itemId, ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).map((x) => str(x, 60)).filter(Boolean);
  const found = await mapByIds(req.db, 'people', wanted);
  const done = await attendedActivity(req.db, plan, itemId);
  const ok = wanted.filter((id) => found[id] && found[id].kind === 'attendee' && !done.has(id));
  return changeShortlist(req, plan, itemId, (list) => [...list, ...ok], `shortlisted ${ok.length} attendee(s)`);
}

async function removePeople(req, plan, itemId, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  return changeShortlist(req, plan, itemId, (list) => list.filter((id) => !drop.has(id)), `removed ${drop.size} from the shortlist`);
}

/**
 * The shortlisted people, sorted by village or area and name. With a plan, each carries `attended`: the
 * session of this planned activity they are already recorded at, if any.
 */
async function shortlistPeople(db, item, plan = null) {
  const people = Object.values(await mapByIds(db, 'people', item.shortlist || []));
  if (plan) {
    const done = await attendedActivity(db, plan, item);
    for (const p of people) p.attended = done.get(p.id) || null;
  }
  return people.sort((a, b) => areaKey(a.location).localeCompare(areaKey(b.location)) || `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
}

/** Attendees registered in the system who match a search, to add one by one. */
async function search(db, term) {
  const q = str(term, 60);
  if (q.length < 2) return [];
  return db.find('people', { where: { kind: 'attendee' }, search: { term: q, fields: ['firstName', 'lastName', 'nrc', 'contact', 'location'] }, limit: 30 });
}

// ---------- Attendance on activity reports ----------

/** Who was invited (the planned activity's shortlist) and who is recorded as attending. */
async function forReport(db, r) {
  let invited = [];
  let plan = null;
  if (r.workplanId && r.workplanItemId) {
    plan = await db.get('workplans', r.workplanId);
    const item = plan && (plan.items || []).find((x) => x.id === r.workplanItemId);
    if (item) invited = item.shortlist || [];
  }
  const claimed = new Set(Array.isArray(r.claimedIds) ? r.claimedIds : (r.attendeeIds || []));
  const ids = [...new Set([...invited, ...claimed, ...(r.attendeeIds || [])])];
  const people = Object.values(await mapByIds(db, 'people', ids))
    .sort((a, b) => areaKey(a.location).localeCompare(areaKey(b.location)) || `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
  const attended = new Set(r.attendeeIds || []);
  const inv = new Set(invited);
  const elsewhere = await reports.onOtherRegisters(db, r, r.id);
  return {
    plan,
    // attended: on the register now (after approval, as verified by the administrator); claimed: ticked by the office.
    rows: people.map((p) => ({
      person: p, invited: inv.has(p.id), attended: attended.has(p.id), claimed: claimed.has(p.id), elsewhere: attended.has(p.id) ? null : elsewhere.get(p.id) || null,
    })),
    verified: Array.isArray(r.claimedIds),
    invitedCount: invited.length,
    attendedCount: attended.size,
    walkIns: [...attended].filter((id) => !inv.has(id)).length,
  };
}

async function mustCorrect(req, r) {
  reports.mustWriteFor(req.user, await reports.officeOf(req.db, r));
  if (statusOf(r) === 'Approved') throw conflict('This attendance has been approved and is locked. An administrator can return it for correction.');
  if (statusOf(r) === 'Submitted') throw conflict('This attendance is waiting for approval. An administrator can return it for correction.');
}

/** Records who attended, from the invited people and those already recorded. */
async function setAttended(req, r, ids, { ifMatch } = {}) {
  await mustCorrect(req, r);
  const { rows } = await forReport(req.db, r);
  // Only invited or recorded people, and nobody already on another register of the same planned activity.
  const allowed = new Set(rows.filter((x) => !x.elsewhere).map((x) => x.person.id));
  const asked = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
  const chosen = asked.filter((id) => allowed.has(id));
  const saved = await req.db.replace('reports', { ...r, attendeeIds: chosen, updatedAt: now() }, ifMatch ? { ifMatch } : {});
  audit(req, 'update', 'reports', r.id, `Attendance corrected: ${chosen.length} attended`);
  saved.skipped = rows.filter((x) => x.elsewhere && asked.includes(x.person.id)).length;
  return saved;
}

async function addRegisterFiles(req, r, files) {
  await mustCorrect(req, r);
  if (!files.length) throw new HttpError(422, 'validation', 'Choose the scans or photos of the signed registers.', { fields: { attachments: 'Choose the scans or photos of the signed registers.' } });
  const saved = await req.db.replace('reports', {
    ...r, attachments: [...(r.attachments || []), ...files.map((f) => ({ ...f, register: true }))], updatedAt: now(),
  });
  audit(req, 'update', 'reports', r.id, `Added ${files.length} signed register file(s)`);
  return saved;
}

async function submit(req, r) {
  await mustCorrect(req, r);
  const problems = [];
  if (!registerFiles(r).length) problems.push('Upload at least one scan or photo of the signed register.');
  if (!(r.attendeeIds || []).length && !(r.otherParticipants > 0)) problems.push('Record who attended, or the number of other participants, first.');
  if (problems.length) throw new HttpError(422, 'validation', problems.join(' '), { fields: { submit: problems.join(' ') } });
  const saved = await req.db.replace('reports', {
    ...r, attendanceStatus: 'Submitted', attendanceSubmittedAt: now(), attendanceSubmittedBy: req.user.id, updatedAt: now(),
  });
  audit(req, 'update', 'reports', r.id, 'Attendance submitted for approval');
  return saved;
}

/**
 * The administrator's check. Once attendance is submitted, only an administrator changes the register:
 * they tick each person the signed registers confirm, and only the ticked people stay on the register and
 * count. "approve" approves submitted attendance; "verify" changes the ticks of approved attendance;
 * "return" sends it back to the office with a note. What the office ticked is kept as claimedIds.
 */
async function decide(req, r, decision, note = '', verified = []) {
  if (!isAdmin(req.user)) throw forbidden('Only an administrator can approve, verify or return attendance.');
  const text = str(note, 1000);
  if (decision === 'approve' || decision === 'verify') {
    if (decision === 'approve' && statusOf(r) !== 'Submitted') throw conflict('Only submitted attendance can be approved.');
    if (decision === 'verify' && statusOf(r) !== 'Approved') throw conflict('Only approved attendance can be verified again.');
    const { rows } = await forReport(req.db, r);
    const allowed = new Set(rows.filter((x) => !x.elsewhere).map((x) => x.person.id));
    const ticked = [...new Set((Array.isArray(verified) ? verified : [verified]).map(String))].filter((id) => allowed.has(id));
    if (!ticked.length && !(r.otherParticipants > 0)) {
      throw new HttpError(422, 'validation', 'Tick the people the signed registers confirm attended.', { fields: { verified: 'Tick the people the signed registers confirm attended.' } });
    }
    const claimedIds = Array.isArray(r.claimedIds) ? r.claimedIds : (r.attendeeIds || []);
    const saved = await req.db.replace('reports', {
      ...r,
      claimedIds,
      attendeeIds: ticked,
      attendanceStatus: 'Approved',
      attendanceDecidedAt: now(),
      attendanceDecidedBy: req.user.id,
      attendanceNote: text || (decision === 'verify' ? r.attendanceNote || '' : ''),
      updatedAt: now(),
    });
    const dropped = claimedIds.filter((id) => !ticked.includes(id)).length;
    audit(req, 'update', 'reports', r.id, `Attendance ${decision === 'approve' ? 'approved' : 'verification changed'}: ${ticked.length} verified${dropped ? `, ${dropped} ticked by the office not confirmed` : ''}`);
    return Object.assign(saved, { dropped });
  }
  if (decision === 'return') {
    if (!['Submitted', 'Approved'].includes(statusOf(r))) throw conflict('Only submitted or approved attendance can be returned.');
    if (!text) throw new HttpError(422, 'validation', 'Say what needs correcting.', { fields: { note: 'Say what needs correcting.' } });
    const saved = await req.db.replace('reports', {
      ...r, attendanceStatus: 'Returned', attendanceDecidedAt: now(), attendanceDecidedBy: req.user.id, attendanceNote: text, updatedAt: now(),
    });
    // The office corrects the register from what the administrator last verified (or its own ticks if never verified).
    audit(req, 'update', 'reports', r.id, `Attendance returned for correction: ${text}`);
    return saved;
  }
  throw notFound('Decision');
}

module.exports = {
  STATUSES, LABEL, statusOf, counts, locked, registerFiles, attendedActivity, areas, importAreas, addPeople, removePeople, shortlistPeople, search,
  forReport, setAttended, addRegisterFiles, submit, decide, mustShortlist,
};
