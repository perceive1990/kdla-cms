'use strict';
// Rules for clients, other parties and activity attendees, shared by the web pages and the API.
const choices = require('../choices');
const config = require('../config');
const { audit } = require('../audit');
const { checkPerson } = require('../conflicts');
const { readPerson, validatePerson, withConsentStamp } = require('../people-core');
const {
  newId, now, str, fullName, today,
} = require('../helpers');
const { notFound } = require('./errors');

const KIND_LABEL = { client: 'Client', defendant: 'Other party', attendee: 'Attendee' };
const SLUG_OF = { client: 'clients', defendant: 'defendants', attendee: 'attendees' };
const KINDS = Object.keys(KIND_LABEL);
const SEARCH_FIELDS = ['firstName', 'lastName', 'nrc', 'contact', 'caseNumber'];

function peopleQuery(params = {}, kind) {
  const where = {};
  if (kind) where.kind = kind;
  if (choices.ageCategories.includes(params.ageCategory)) where.ageCategory = params.ageCategory;
  if (params.disability && choices.disability.includes(params.disability)) where.disability = params.disability;
  if (params.projectId) where.projectId = String(params.projectId).slice(0, 60);
  if (params.consent === 'missing') where.$or = [{ consentRecord: null }, { consentRecord: { $in: ['', 'no'] } }];
  const q = { where };
  const term = str(params.q, 80);
  if (term) q.search = { term, fields: SEARCH_FIELDS };
  return q;
}

async function getPerson(db, id, kind) {
  const p = await db.get('people', id);
  if (!p || (kind && p.kind !== kind)) throw notFound('Person');
  return p;
}

/**
 * Register a person after validation.
 * Returns { matches } instead of saving when possible duplicates or conflicts of interest
 * exist and the user has not confirmed them.
 */
async function createPerson(req, kind, v, { confirm = false } = {}) {
  const matches = await checkPerson(req.db, { kind, ...v });
  if ((matches.duplicates.length || matches.conflicts.length) && !confirm) return { matches };
  const doc = withConsentStamp({
    id: newId(), kind, ...v, addedBy: req.user.id, createdAt: now(), updatedAt: now(),
  }, null, req.user);
  const saved = await req.db.create('people', doc);
  audit(req, 'create', 'people', doc.id, `Registered ${KIND_LABEL[kind].toLowerCase()} ${fullName(doc)}`);
  if (matches.conflicts.length) audit(req, 'create', 'people', doc.id, `Possible conflict of interest acknowledged for ${fullName(doc)}`);
  return { doc: saved, matches };
}

async function updatePerson(req, p, v, { confirm = false, ifMatch } = {}) {
  if (v.nameKey !== p.nameKey || v.nrc !== p.nrc) {
    const matches = await checkPerson(req.db, { kind: p.kind, ...v, selfId: p.id });
    if ((matches.duplicates.length || matches.conflicts.length) && !confirm) return { matches };
  }
  const updated = withConsentStamp({ ...p, ...v, updatedAt: now() }, p, req.user);
  const saved = await req.db.replace('people', updated, { ifMatch });
  audit(req, 'update', 'people', p.id, `Updated ${KIND_LABEL[p.kind].toLowerCase()} ${fullName(updated)}`);
  return { doc: saved };
}

/** Delete a person and detach them from cases and reports (the cases and reports stay). */
async function deletePerson(req, p) {
  const field = { client: 'clientIds', defendant: 'defendantIds' }[p.kind];
  if (field) {
    const linked = await req.db.find('cases', { where: { [field]: { $contains: p.id } } });
    for (const c of linked) await req.db.replace('cases', { ...c, [field]: c[field].filter((x) => x !== p.id), updatedAt: now() });
  }
  if (p.kind === 'client') {
    const opp = await req.db.find('people', { where: { kind: 'defendant', versusClientId: p.id } });
    for (const o of opp) await req.db.replace('people', { ...o, versusClientId: '', updatedAt: now() });
  }
  if (p.kind === 'attendee') {
    const reps = await req.db.find('reports', { where: { attendeeIds: { $contains: p.id } } });
    for (const r of reps) await req.db.replace('reports', { ...r, attendeeIds: r.attendeeIds.filter((x) => x !== p.id), updatedAt: now() });
  }
  await req.db.remove('people', p.id);
  audit(req, 'delete', 'people', p.id, `Deleted ${KIND_LABEL[p.kind].toLowerCase()} ${fullName(p)}`);
}

/** Everything held about one person, for a data subject access request (Data Protection Act 2021). */
async function personalData(req, p) {
  const field = { client: 'clientIds', defendant: 'defendantIds' }[p.kind];
  const cases = field ? await req.db.find('cases', { where: { [field]: { $contains: p.id } } }) : [];
  const caseIds = cases.map((c) => c.id);
  const notes = [];
  for (const id of caseIds) notes.push(...await req.db.find('caseNotes', { where: { caseId: id } }));
  const referrals = caseIds.length ? await req.db.find('referrals', { where: { caseId: { $in: caseIds } } }) : [];
  const reports = await req.db.find('reports', { where: { attendeeIds: { $contains: p.id } }, fields: ['id', 'heading', 'date', 'activityType', 'district'] });
  const stripFiles = (c) => ({ ...c, attachments: (c.attachments || []).map((a) => ({ name: a.name, size: a.size, uploadedAt: a.uploadedAt })) });
  audit(req, 'export', 'people', p.id, `Data access export for ${fullName(p)}`);
  return {
    exportedAt: now(), exportedBy: req.user.username, organisation: config.orgFullName,
    person: p, cases: cases.map(stripFiles), caseNotes: notes, referrals, activityReports: reports,
  };
}

module.exports = {
  KIND_LABEL, SLUG_OF, KINDS, peopleQuery, getPerson, readPerson, validatePerson, createPerson, updatePerson, deletePerson,
  personalData, today,
};
