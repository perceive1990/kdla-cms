'use strict';
// Small data upgrades run at start-up. Each step only touches records that need it,
// so after the first run they cost almost nothing.
const { nameKey } = require('./conflicts');

async function runMigrations(db) {
  let changed = 0;

  // People: normalised name for conflict and duplicate checks.
  const people = await db.find('people', { where: { nameKey: null } });
  for (const p of people) {
    await db.replace('people', { ...p, nameKey: nameKey(p.firstName, p.lastName) });
    changed += 1;
  }

  // Cases: opening date, confidentiality flag and team list.
  const cases = await db.find('cases', { where: { openedOn: null } });
  for (const c of cases) {
    await db.replace('cases', {
      ...c,
      openedOn: String(c.createdAt || new Date().toISOString()).slice(0, 10),
      restricted: c.restricted === true,
      teamIds: c.teamIds || [],
    });
    changed += 1;
  }

  // Activity reports: the office each belongs to (from its work plan, else from who compiled it).
  const reports = await db.find('reports', { where: { office: null } });
  if (reports.length) {
    const { officeOf } = require('./services/reports');
    for (const r of reports) {
      await db.replace('reports', { ...r, office: await officeOf(db, r) });
      changed += 1;
    }
  }

  if (changed) console.log(`Data upgrade: updated ${changed} record(s).`);
  return changed;
}

module.exports = { runMigrations };
