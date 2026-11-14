'use strict';
// Importing activity attendees from attendance registers (Word or CSV). First a preview says what will
// happen to each line; then saving registers the new people and links the ones already registered.
const choices = require('../choices');
const { audit } = require('../audit');
const { newId, now, str } = require('../helpers');
const { normaliseNrc, readPerson, withConsentStamp } = require('../people-core');
const { mustWriteFor } = require('./reports');
const { splitName } = require('../register-import');

const STATUS = {
  new: 'New: will be registered',
  existing: 'Already registered (same NRC): office and area added where missing',
  duplicate: 'Repeated in this register: skipped',
  absent: 'Marked absent: skipped',
  problem: 'Cannot be imported',
};

/** What will happen to each person of the register. */
async function preview(db, people, { adults = true } = {}) {
  const existing = new Map();
  // Stray characters (a trailing ` or full stop) are dropped from NRCs before they are checked.
  const cleanNrc = (raw) => normaliseNrc(String(raw || '').replace(/[^\d/]/g, ''));
  const nrcs = [...new Set(people.map((p) => cleanNrc(p.nrcRaw)).filter((n) => /^\d{6}\/\d{2}\/\d$/.test(n)))];
  for (let i = 0; i < nrcs.length; i += 100) {
    const found = await db.find('people', { where: { kind: 'attendee', nrc: { $in: nrcs.slice(i, i + 100) } }, fields: ['id', 'firstName', 'lastName', 'nrc', 'office', 'location'] });
    for (const p of found) existing.set(p.nrc, p);
  }
  const seen = new Map();
  return people.map((p, i) => {
    const line = p.serial || String(i + 1);
    const nrc = cleanNrc(p.nrcRaw);
    const nrcOk = /^\d{6}\/\d{2}\/\d$/.test(nrc);
    const notes = [];
    if (p.nrcRaw && !nrcOk) notes.push(`NRC "${p.nrcRaw}" looks mistyped, so it is left out`);
    const { firstName, lastName } = splitName(p.fullName);
    const ageCategory = adults ? ({ F: 'Woman', M: 'Man' }[p.sex] || '') : '';
    const row = {
      line, fullName: p.fullName, firstName, lastName, nrc: nrcOk ? nrc : '', sex: p.sex, ageCategory, area: p.area, phone: p.phone, notes,
    };
    if (p.absent) return { ...row, status: 'absent' };
    if (nrcOk && seen.has(nrc)) return { ...row, status: 'duplicate', notes: [...notes, `same NRC as line ${seen.get(nrc)}`] };
    if (nrcOk) seen.set(nrc, line);
    if (nrcOk && existing.has(nrc)) return { ...row, status: 'existing', personId: existing.get(nrc).id };
    if (!lastName) return { ...row, status: 'problem', notes: [...notes, 'only one name'] };
    if (!ageCategory) return { ...row, status: 'problem', notes: [...notes, adults ? 'sex not recorded' : 'age not recorded'] };
    return { ...row, status: 'new' };
  });
}

/** Registers the new people and links those already registered, for one office. */
async function save(req, rows, { office, activity = '', location = '' }) {
  mustWriteFor(req.user, office);
  let added = 0; let updated = 0;
  const ids = [];
  for (const r of rows) {
    if (r.status === 'existing') {
      ids.push(r.personId);
      const p = await req.db.get('people', r.personId);
      if (p && (!p.office || !p.location)) {
        await req.db.replace('people', { ...p, office: p.office || office, location: p.location || r.area || location, updatedAt: now() });
        updated += 1;
      }
    } else if (r.status === 'new') {
      const v = readPerson({
        firstName: r.firstName, lastName: r.lastName, nrc: r.nrc, contact: r.phone, ageCategory: r.ageCategory, location: r.area || location, office, activity,
      }, 'attendee');
      const id = newId();
      ids.push(id);
      await req.db.create('people', withConsentStamp({
        id, kind: 'attendee', ...v, importedFrom: str(req.body.source, 200), addedBy: req.user.id, createdAt: now(), updatedAt: now(),
      }, null, req.user));
      added += 1;
    }
  }
  audit(req, 'create', 'people', null, `Imported an attendance register for ${office}: ${added} attendees added, ${updated} already registered updated`);
  return { added, updated, ids };
}

const validOffice = (o) => choices.offices.includes(o);

module.exports = {
  STATUS, preview, save, validOffice,
};
