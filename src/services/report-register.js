'use strict';
// Adds the people of an attendance register (Word or CSV) to an activity report being written: from the report
// form, and from drafts written offline (their typed list of names arrives as a CSV register).
const { str } = require('../helpers');
const { HttpError } = require('./errors');
const reports = require('./reports');

/**
 * Imports an attendance register (Word or CSV) chosen on the report form: new people are registered as
 * attendees of the report's office, those already registered (same NRC) are matched, and all of them are
 * added to the report's attendees, except anyone already on another register of the same planned activity.
 * Returns a sentence for the message, or throws 422 when the file cannot be read.
 */
async function importRegister(req, v, file, { adults = true, selfId = null } = {}) {
  if (!file) return '';
  const importer = require('../services/attendee-import');
  let people;
  try { people = require('../register-import').readRegister(file); } catch { people = null; }
  if (!people || !people.length) throw new HttpError(422, 'validation', 'The register file could not be read, or has no table of names. Save it as a Word document (.docx) or CSV and try again.', { fields: { registerFile: 'Choose a Word (.docx) or CSV register with a table of names.' } });
  const rows = await importer.preview(req.db, people, { adults });
  if (!rows.some((x) => ['new', 'existing'].includes(x.status))) {
    const msg = `No one on this register could be imported (${rows.length} line${rows.length === 1 ? '' : 's'} read). Each line needs a first and last name and the sex, or an NRC already registered.`;
    throw new HttpError(422, 'validation', msg, { fields: { registerFile: msg } });
  }
  req.body = { ...(req.body || {}), source: str(file.originalname, 200) };
  const { added, ids } = await importer.save(req, rows, { office: v.office, activity: v.activityType || '', location: v.location || '' });
  const elsewhere = await reports.onOtherRegisters(req.db, v, selfId);
  const keep = ids.filter((id) => !elsewhere.has(id));
  const before = new Set(v.attendeeIds);
  v.attendeeIds = [...new Set([...v.attendeeIds, ...keep])];
  const linked = v.attendeeIds.length - before.size;
  const skipped = rows.filter((x) => x.status === 'problem').length;
  return ` Register imported: ${linked} attendee${linked === 1 ? '' : 's'} added to this report (${added} newly registered)`
    + `${ids.length - keep.length ? `, ${ids.length - keep.length} left off because they are on another register of this activity` : ''}`
    + `${skipped ? `, ${skipped} line${skipped === 1 ? '' : 's'} could not be imported (missing a name or sex); add ${skipped === 1 ? 'it' : 'them'} on the attendance page` : ''}.`;
}

module.exports = { importRegister };
