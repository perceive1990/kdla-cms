'use strict';
// Payment acquittal for an activity: the costs its attendees are eligible for (transport, lunch, dinner,
// incidental, accommodation, airtime or anything else), at rates set for the activity, printed for each
// person to sign on receipt. It is kept on the
// activity report. Staff of the report's office prepare it; once the attendance is approved it is locked to
// administrators, like the register.
const { audit } = require('../audit');
const { now, str } = require('../helpers');
const { forbidden, HttpError } = require('./errors');
const reports = require('./reports');
const attendance = require('./attendance');
const { statusOf } = require('../attendance-status');

// The costs an activity can pay. Each activity ticks the ones its attendees are eligible for and sets their
// rates and how many days each is paid for; up to three "other" costs take any name. Only the ticked costs appear on the page and the form.
const CATALOGUE = [
  { key: 'transport', label: 'Transport' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'incidental', label: 'Incidental' },
  { key: 'accommodation', label: 'Accommodation', perNight: true },
  { key: 'airtime', label: 'Airtime' },
];
const OTHERS = ['other1', 'other2', 'other3'];
const { CURRENCIES } = require('./directory');
const isAdmin = (u) => Boolean(u && u.role === 'admin');

const money = (raw) => {
  const n = Number(String(raw ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

/**
 * The acquittal kept on a report or planned activity: `costs` lists every possible cost with whether it
 * applies (`on`), its label and rate; `active` the ones that apply; each row says which costs a person gets.
 * Acquittals saved before costs could be chosen (fixed transport, incidental and accommodation) are read too.
 */
function of(holder) {
  const a = holder.acquittal || {};
  const saved = Array.isArray(a.costs) ? Object.fromEntries(a.costs.map((c) => [c.key, c])) : null;
  const legacyRows = Array.isArray(a.rows) ? a.rows : [];
  const costs = [...CATALOGUE, ...OTHERS.map((key, i) => ({ key, label: '', other: true, n: i + 1 }))].map((c) => {
    if (saved) {
      const s = saved[c.key];
      return {
        ...c, on: Boolean(s), rate: s ? s.rate : null, days: c.perNight ? 1 : (s && s.days) || 1, label: c.other ? (s ? s.label : '') : c.label,
      };
    }
    const rate = a.rates ? a.rates[c.key] ?? null : null;
    const used = legacyRows.some((r) => r[c.key]);
    return {
      ...c, on: !c.other && (rate !== null || used), rate, days: 1,
    };
  });
  const rows = legacyRows.map((r) => ({
    personId: r.personId,
    items: r.items || Object.fromEntries(costs.filter((c) => r[c.key]).map((c) => [c.key, true])),
    nights: r.nights || 0,
  }));
  return {
    currency: a.currency || 'ZMW', costs, active: costs.filter((c) => c.on), rows, preparedBy: a.preparedBy || '', updatedAt: a.updatedAt || '',
  };
}

/** What each person on the acquittal receives, with totals per cost and overall. */
function totals(acq) {
  const sums = Object.fromEntries(acq.active.map((c) => [c.key, 0]));
  sums.total = 0;
  const lines = acq.rows.map((row) => {
    const line = { ...row, amounts: {}, total: 0 };
    for (const c of acq.active) {
      // A cost is paid at its rate for each of its days (lunch for a three-day workshop: rate × 3); accommodation per night.
      const times = c.perNight ? Math.max(1, row.nights || 1) : Math.max(1, c.days || 1);
      const amount = row.items[c.key] ? Math.round((c.rate || 0) * times * 100) / 100 : 0;
      line.amounts[c.key] = amount;
      line.total += amount;
      sums[c.key] += amount;
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
  const costs = [];
  for (const c of [...CATALOGUE, ...OTHERS.map((key, i) => ({ key, other: true, label: `Other ${i + 1}` }))]) {
    if (body[`cost_${c.key}`] !== '1') continue;
    const label = c.other ? str(body[`label_${c.key}`], 40) : c.label;
    const raw = str(body[`rate_${c.key}`], 20);
    const rate = money(raw);
    const name = c.other ? (label || `other cost ${c.key.slice(-1)}`) : c.label.toLowerCase();
    if (c.other && !label) fields[`label_${c.key}`] = `Name the other cost ${c.key.slice(-1)}, for example "Stationery", or untick it.`;
    if (raw === '' || rate === null || rate === 0) fields[`rate_${c.key}`] = `Set the ${name} rate, or untick ${name} for this activity.`;
    const days = Number.parseInt(body[`days_${c.key}`], 10);
    costs.push({
      key: c.key, label, rate, ...(c.perNight ? { perNight: true } : { days: Number.isInteger(days) ? Math.min(60, Math.max(1, days)) : 1 }),
    });
  }
  const allowed = new Set(allowedIds);
  const ticked = Object.fromEntries(costs.map((c) => [c.key, new Set([].concat(body[c.key] || []).map(String).filter((id) => allowed.has(id)))]));
  const rows = [...allowed].map((personId) => {
    const items = Object.fromEntries(costs.filter((c) => ticked[c.key].has(personId)).map((c) => [c.key, true]));
    const nights = Number.parseInt(body[`nights_${personId}`], 10);
    return { personId, items, nights: items.accommodation ? Math.min(30, Math.max(1, Number.isInteger(nights) ? nights : 1)) : 0 };
  }).filter((r) => Object.keys(r.items).length);
  if (Object.keys(fields).length) throw new HttpError(422, 'validation', Object.values(fields)[0], { fields });
  return {
    currency, costs, rows, preparedBy: req.user.id, updatedAt: now(),
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
  CATALOGUE, OTHERS, CURRENCIES, of, totals, parse, save, saveForItem, itemPeople, forReport, canEdit, mustEdit,
};
