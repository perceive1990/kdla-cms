'use strict';
// Rules for activity reports and attendance registers, shared by the web pages and the API.
const choices = require('../choices');
const { audit } = require('../audit');
const { readPerson, validatePerson, withConsentStamp } = require('../people-core');
const {
  newId, now, arr, str, intOrNull, mapByIds, isRealDate,
} = require('../helpers');
const { removeAttachments } = require('./attachments');
const { notFound, forbidden } = require('./errors');
const rich = require('../richtext');

const RICH_FIELDS = ['introduction', 'objectives', 'implementation', 'immediateResults', 'challenges', 'recommendations'];

/** Work plan link: the web form sends "planId:itemId" as workplanItem; the API sends the two ids. */
function readWorkplanLink(body) {
  if (Object.prototype.hasOwnProperty.call(body, 'workplanItem')) {
    const [workplanId = '', workplanItemId = ''] = str(body.workplanItem, 120).split(':');
    return { workplanId, workplanItemId };
  }
  return { workplanId: str(body.workplanId), workplanItemId: str(body.workplanItemId) };
}

function readReport(body) {
  return {
    ...readWorkplanLink(body),
    activityType: str(body.activityType),
    heading: str(body.heading, 300),
    activityNumber: intOrNull(body.activityNumber),
    date: str(body.date, 10),
    office: str(body.office),
    district: str(body.district),
    location: str(body.location, 200),
    projectId: str(body.projectId),
    // Formatted text from the report editor (safe HTML), or plain text.
    introduction: rich.clean(body.introduction),
    objectives: rich.clean(body.objectives),
    implementation: rich.clean(body.implementation),
    immediateResults: rich.clean(body.immediateResults),
    challenges: rich.clean(body.challenges),
    recommendations: rich.clean(body.recommendations),
    attendeeIds: [...new Set(arr(body.attendeeIds))],
    partnerIds: [...new Set(arr(body.partnerIds))],
    otherParticipants: intOrNull(body.otherParticipants),
    compiledById: str(body.compiledById),
  };
}

async function validateReport(db, v) {
  const e = {};
  if (!v.heading) e.heading = 'Enter a heading.';
  if (!choices.activities.includes(v.activityType)) e.activityType = 'Select the type of activity.';
  if (!isRealDate(v.date)) e.date = 'Enter the date of the activity.';
  if (v.district && !choices.districts.includes(v.district)) e.district = 'Select a valid district.';
  if (!choices.offices.includes(v.office)) e.office = 'Select the office this report belongs to.';
  if (Number.isNaN(v.activityNumber)) e.activityNumber = 'Activity number must be a whole number.';
  if (Number.isNaN(v.otherParticipants) || (v.otherParticipants !== null && v.otherParticipants < 0)) e.otherParticipants = 'Enter a whole number.';
  if (!v.introduction) e.introduction = 'Enter an introduction.';
  if (!v.objectives) e.objectives = 'Enter the objectives.';
  if (!v.implementation) e.implementation = 'Describe how the activity was implemented.';
  if (!v.compiledById || !(await db.get('users', v.compiledById))) e.compiledById = 'Select who compiled the report.';
  if (v.projectId && !(await db.get('projects', v.projectId))) e.projectId = 'Select a valid project.';
  if (v.workplanId || v.workplanItemId) {
    // Both ids are needed. To unlink a report, send both empty.
    const plan = /^[\w-]{1,60}$/.test(v.workplanId) ? await db.get('workplans', v.workplanId) : null;
    const item = plan && (plan.items || []).find((it) => it.id === v.workplanItemId);
    if (!item) {
      e.workplanItemId = 'Select a valid work plan activity.';
    } else if (plan.office && v.office && plan.office !== v.office) {
      e.workplanItemId = `This activity is in the ${plan.office} work plan. Choose an activity of ${v.office}.`;
    } else if (v.activityNumber === null && Number.isInteger(item.number)) {
      v.activityNumber = item.number; // the report takes the activity number from the work plan
    }
  }
  const att = await mapByIds(db, 'people', v.attendeeIds);
  if (v.attendeeIds.some((id) => !att[id] || att[id].kind !== 'attendee')) e.attendeeIds = 'One of the selected attendees no longer exists.';
  const partners = await mapByIds(db, 'stakeholders', v.partnerIds);
  if (v.partnerIds.some((id) => !partners[id])) e.partnerIds = 'One of the selected partner organisations no longer exists.';
  return e;
}

function reportQuery(params = {}) {
  const where = {};
  if (choices.districts.includes(params.district)) where.district = params.district;
  if (choices.activities.includes(params.activityType)) where.activityType = params.activityType;
  if (params.projectId) where.projectId = String(params.projectId).slice(0, 60);
  if (choices.offices.includes(params.office)) where.office = params.office;
  if (params.workplanId) where.workplanId = String(params.workplanId).slice(0, 60);
  if (isRealDate(params.from)) where.date = { $gte: params.from };
  if (isRealDate(params.to)) where.date = { ...(where.date || {}), $lte: params.to };
  const q = { where };
  const term = str(params.q, 80);
  if (term) q.search = { term, fields: ['heading', 'introduction', 'objectives', 'location'] };
  return q;
}

// ---------- Offices: staff write activity reports only for their own office ----------
const isAdmin = (user) => Boolean(user && user.role === 'admin');

/** The office a report belongs to: its own, else its work plan's, else the office of the colleague who compiled it. */
async function officeOf(db, r) {
  if (r.office) return r.office;
  if (r.workplanId) {
    const plan = await db.get('workplans', r.workplanId);
    if (plan && plan.office) return plan.office;
  }
  if (r.compiledById) {
    const u = await db.get('users', r.compiledById);
    if (u && u.office) return u.office;
  }
  return '';
}

/**
 * Who may write or change a report of an office: administrators for every office, other staff only
 * for their own. Reports and work plans that belong to no office are open to everyone with an office.
 */
function canWriteFor(user, office) {
  if (isAdmin(user)) return true;
  return Boolean(user && user.office) && (!office || office === user.office);
}

function mustWriteFor(user, office) {
  if (canWriteFor(user, office)) return;
  if (!user || !user.office) throw forbidden('Your account has no office yet, so you cannot write activity reports. Ask an administrator to set your office.');
  throw forbidden(`Only staff of ${office} can write or change its activity reports. You are in ${user.office}.`);
}

/**
 * Settles the office of a report being written: staff always write for their own office; administrators
 * choose, and otherwise keep the report's office or take the work plan's or their own. Throws 403 when the
 * person may not write for the report (an existing one) or for the chosen work plan activity.
 */
async function settleOffice(req, v, existing = null) {
  const user = req.user;
  if (existing) mustWriteFor(user, await officeOf(req.db, existing));
  const plan = v.workplanId && /^[\w-]{1,60}$/.test(v.workplanId) ? await req.db.get('workplans', v.workplanId) : null;
  if (isAdmin(user)) {
    v.office = v.office || (existing && existing.office) || (plan && plan.office) || (existing ? await officeOf(req.db, existing) : '') || user.office || '';
  } else {
    mustWriteFor(user, '');
    v.office = user.office;
    if (plan && plan.office) mustWriteFor(user, plan.office);
  }
  return v;
}

async function getReport(db, id) {
  const r = await db.get('reports', id);
  if (!r) throw notFound('Report');
  return r;
}

async function createReport(req, v, attachments = []) {
  mustWriteFor(req.user, v.office);
  const doc = {
    id: newId(), ...v, attachments, createdBy: req.user.id, createdAt: now(), updatedAt: now(),
  };
  const saved = await req.db.create('reports', doc);
  audit(req, 'create', 'reports', doc.id, `Created report "${doc.heading}"`);
  return saved;
}

async function updateReport(req, r, v, { ifMatch, attachments = [] } = {}) {
  mustWriteFor(req.user, await officeOf(req.db, r));
  mustWriteFor(req.user, v.office);
  const saved = await req.db.replace('reports', {
    ...r, ...v, attachments: [...(r.attachments || []), ...attachments], updatedAt: now(),
  }, { ifMatch });
  audit(req, 'update', 'reports', r.id, `Updated report "${saved.heading}"`);
  return saved;
}

async function deleteReport(req, r) {
  await removeAttachments(r.attachments);
  await req.db.remove('reports', r.id);
  audit(req, 'delete', 'reports', r.id, `Deleted report "${r.heading}"`);
}

const BULK_FIELDS = ['firstName', 'lastName', 'ageCategory', 'age', 'nrc', 'contact', 'disability', 'location'];

/**
 * Attendance register: create many attendees and link them to the report.
 * rows: [{ firstName, lastName, ageCategory, age, nrc, contact, disability, location }]
 * Returns { rowErrors } (index -> message) without saving anything if any row is invalid,
 * otherwise { added, linked, report }.
 */
async function addAttendees(req, r, rawRows, consent = {}) {
  mustWriteFor(req.user, await officeOf(req.db, r));
  const rows = (rawRows || []).slice(0, 200).map((row) => Object.fromEntries(BULK_FIELDS.map((f) => [f, str(row && row[f], 200)])));
  const filled = rows.map((row, i) => ({ row, i })).filter(({ row }) => BULK_FIELDS.some((f) => row[f] && !(f === 'disability' && row[f] === 'Not Disabled')));
  if (!filled.length) return { rowErrors: {}, empty: true, rows };

  const rowErrors = {};
  const prepared = [];
  const seenNrc = new Set();
  for (const { row, i } of filled) {
    const v = readPerson({
      ...row, activity: r.activityType, projectId: r.projectId, location: row.location || r.location || '',
      consentRecord: consent.consentRecord, consentShare: consent.consentShare,
    }, 'attendee');
    if (!choices.disability.includes(v.disability)) v.disability = 'Not Disabled';
    const e = await validatePerson(req.db, { ...v, nrc: '' }, 'attendee');
    if (v.nrc && !/^\d{6}\/\d{2}\/\d$/.test(v.nrc)) e.nrc = 'NRC must look like 123456/78/1.';
    if (v.nrc && seenNrc.has(v.nrc)) e.nrc = 'This NRC appears twice in the register.';
    if (v.nrc) seenNrc.add(v.nrc);
    if (Object.keys(e).length) rowErrors[i] = Object.values(e).join(' ');
    prepared.push({ v, i });
  }
  if (Object.keys(rowErrors).length) return { rowErrors, rows };

  let added = 0; let linked = 0;
  const ids = new Set(r.attendeeIds || []);
  for (const { v } of prepared) {
    // Someone already registered with the same NRC is linked rather than added twice.
    const existing = v.nrc ? (await req.db.find('people', { where: { kind: 'attendee', nrc: v.nrc }, limit: 1 }))[0] : null;
    if (existing) {
      if (!ids.has(existing.id)) { ids.add(existing.id); linked += 1; }
      continue;
    }
    const doc = withConsentStamp({
      id: newId(), kind: 'attendee', ...v, addedBy: req.user.id, createdAt: now(), updatedAt: now(),
    }, null, req.user);
    await req.db.create('people', doc);
    ids.add(doc.id);
    added += 1;
  }
  const fresh = await req.db.get('reports', r.id);
  const report = await req.db.replace('reports', { ...fresh, attendeeIds: [...ids], updatedAt: now() });
  audit(req, 'update', 'reports', r.id, `Attendance register: ${added} added, ${linked} linked`);
  return { added, linked, report };
}

module.exports = {
  RICH_FIELDS, officeOf, canWriteFor, mustWriteFor, settleOffice, readReport, validateReport, reportQuery, getReport, createReport, updateReport, deleteReport, addAttendees, BULK_FIELDS,
};
