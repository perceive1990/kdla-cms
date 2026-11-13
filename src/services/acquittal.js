'use strict';
// Payment acquittal for an activity: the attendees eligible for transport, incidental and accommodation
// allowances, at rates set for the activity, printed for each person to sign on receipt. It is kept on the
// activity report. Staff of the report's office prepare it; once the attendance is approved it is locked to
// administrators, like the register.
const { audit } = require('../audit');
const { now, str } = require('../helpers');
const { forbidden, HttpError } = require('./errors');
const reports = require('./reports');
const attendance = require('./attendance');
const { statusOf } = require('../attendance-status');

const ALLOWANCES = [
  { key: 'transport', label: 'Transport' },
  { key: 'incidental', label: 'Incidental' },
  { key: 'accommodation', label: 'Accommodation', perNight: true },
];
const { CURRENCIES } = require('./directory');
const isAdmin = (u) => Boolean(u && u.role === 'admin');

const money = (raw) => {
  const n = Number(String(raw ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

/** The acquittal kept on a report, with defaults. */
function of(r) {
  const a = r.acquittal || {};
  return {
    currency: a.currency || 'ZMW',
    rates: { transport: null, incidental: null, accommodation: null, ...(a.rates || {}) },
    rows: Array.isArray(a.rows) ? a.rows : [],
    preparedBy: a.preparedBy || '',
    updatedAt: a.updatedAt || '',
  };
}

/** What each person on the acquittal receives, with totals per allowance and overall. */
function totals(acq) {
  const sums = { transport: 0, incidental: 0, accommodation: 0, total: 0 };
  const lines = acq.rows.map((row) => {
    const line = { ...row, amounts: {}, total: 0 };
    for (const a of ALLOWANCES) {
      const rate = acq.rates[a.key] || 0;
      const amount = row[a.key] ? Math.round(rate * (a.perNight ? Math.max(1, row.nights || 1) : 1) * 100) / 100 : 0;
      line.amounts[a.key] = amount;
      line.total += amount;
      sums[a.key] += amount;
    }
    line.total = Math.round(line.total * 100) / 100;
    sums.total += line.total;
    return line;
  });
  for (const k of Object.keys(sums)) sums[k] = Math.round(sums[k] * 100) / 100;
  return { lines, sums, people: lines.filter((l) => l.total > 0).length };
}

/** Who may change the acquittal: the report's office staff until attendance is approved, then administrators. */
async function mustEdit(req, r) {
  reports.mustWriteFor(req.user, await reports.officeOf(req.db, r));
  if (statusOf(r) === 'Approved' && !isAdmin(req.user)) {
    throw forbidden('The attendance of this activity is approved, so only an administrator can change its payment acquittal.');
  }
}

async function canEdit(req, r) {
  try { await mustEdit(req, r); return true; } catch { return false; }
}

/**
 * Reads the rates and who receives which allowance from the form. Only the people in `allowedIds` can be
 * added. Throws 422 with the fields to fix.
 */
function parse(req, body, allowedIds) {
  const fields = {};
  const currency = CURRENCIES.includes(body.currency) ? body.currency : 'ZMW';
  const rates = {};
  for (const a of ALLOWANCES) {
    const v = str(body[`rate_${a.key}`], 20);
    rates[a.key] = v === '' ? null : money(v);
    if (v !== '' && rates[a.key] === null) fields[`rate_${a.key}`] = `Enter the ${a.label.toLowerCase()} rate as an amount, for example 150.`;
  }
  const allowed = new Set(allowedIds);
  const pick = (name) => new Set([].concat(body[name] || []).map(String).filter((id) => allowed.has(id)));
  const on = { transport: pick('transport'), incidental: pick('incidental'), accommodation: pick('accommodation') };
  const ids = [...allowed].filter((id) => on.transport.has(id) || on.incidental.has(id) || on.accommodation.has(id));
  const rows = ids.map((personId) => {
    const nights = Number.parseInt(body[`nights_${personId}`], 10);
    return {
      personId, transport: on.transport.has(personId), incidental: on.incidental.has(personId), accommodation: on.accommodation.has(personId),
      nights: on.accommodation.has(personId) ? Math.min(30, Math.max(1, Number.isInteger(nights) ? nights : 1)) : 0,
    };
  });
  for (const a of ALLOWANCES) {
    if (rows.some((x) => x[a.key]) && !rates[a.key] && !fields[`rate_${a.key}`]) fields[`rate_${a.key}`] = `Set the ${a.label.toLowerCase()} rate, or untick ${a.label.toLowerCase()} for everyone.`;
  }
  if (Object.keys(fields).length) throw new HttpError(422, 'validation', Object.values(fields)[0], { fields });
  return {
    currency, rates, rows, preparedBy: req.user.id, updatedAt: now(),
  };
}

/**
 * Saves the acquittal of an activity report. Only people on the activity's attendance (invited or
 * recorded, and not on another register of the same planned activity) can be added.
 */
async function save(req, r, body) {
  await mustEdit(req, r);
  const { rows: people } = await attendance.forReport(req.db, r);
  const acq = parse(req, body, people.filter((x) => !x.elsewhere).map((x) => x.person.id));
  const saved = await req.db.replace('reports', { ...r, acquittal: acq, updatedAt: now() });
  const t = totals(of(saved));
  audit(req, 'update', 'reports', r.id, `Payment acquittal: ${t.people} people, ${acq.currency} ${t.sums.total}`);
  return saved;
}

/** The planned activity's acquittal, prepared before the activity for the people on its invite list. */
async function itemPeople(db, plan, item) {
  return (await attendance.shortlistPeople(db, item, plan)).map((p) => ({ person: p, invited: true, attended: false, elsewhere: p.attended || null }));
}

async function saveForItem(req, plan, itemId, body) {
  attendance.mustShortlist(req.user, plan);
  const workplans = require('./workplans');
  const item = workplans.getItem(plan, itemId);
  const people = await itemPeople(req.db, plan, item);
  const acq = parse(req, body, people.filter((x) => !x.elsewhere).map((x) => x.person.id));
  await workplans.savePlan(req.db, plan, (cur) => ({
    ...cur, items: cur.items.map((x) => (x.id === itemId ? { ...x, acquittal: acq, updatedAt: now() } : x)),
  }));
  const t = totals(of({ acquittal: acq }));
  audit(req, 'update', 'workplans', plan.id, `Work plan "${plan.title}": payment acquittal for activity ${item.number ?? ''} ${item.title}: ${t.people} people, ${acq.currency} ${t.sums.total}`.replace(/\s+/g, ' '));
  return { acq, t };
}

/** The acquittal a report starts from: its own, else the one prepared on its planned activity. */
async function forReport(db, r) {
  if (r.acquittal) return { acq: of(r), fromPlan: false };
  if (r.workplanId && r.workplanItemId) {
    const plan = await db.get('workplans', r.workplanId);
    const item = plan && (plan.items || []).find((x) => x.id === r.workplanItemId);
    if (item && item.acquittal) return { acq: of(item), fromPlan: true };
  }
  return { acq: of(r), fromPlan: false };
}

module.exports = {
  ALLOWANCES, CURRENCIES, of, totals, parse, save, saveForItem, itemPeople, forReport, canEdit, mustEdit,
};
