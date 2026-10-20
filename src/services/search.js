'use strict';
// Search across records and the conflict of interest check, shared by the web pages and the API.
const { visibleWhere, canSeeCase } = require('../access');
const { nameKey } = require('../conflicts');
const { str } = require('../helpers');

/** Search cases (only those the user may see), people, reports and organisations. Needs 2 or more characters. */
async function searchAll(req, q) {
  const term = String(q || '').trim().slice(0, 80);
  if (term.length < 2) return { term, cases: [], people: [], reports: [], orgs: [] };
  const [cases, people, reports, orgs] = await Promise.all([
    req.db.find('cases', {
      where: visibleWhere(req.user, {}), search: { term, fields: ['heading', 'caseNumber', 'complaint'] }, orderBy: ['updatedAt', 'DESC'], limit: 30,
    }),
    req.db.find('people', { search: { term, fields: ['firstName', 'lastName', 'nrc', 'contact', 'caseNumber', 'nameKey'] }, orderBy: ['lastName', 'ASC'], limit: 30 }),
    req.db.find('reports', { search: { term, fields: ['heading', 'location'] }, orderBy: ['date', 'DESC'], limit: 15 }),
    req.db.find('stakeholders', { search: { term, fields: ['name', 'services', 'contactPerson'] }, orderBy: ['name', 'ASC'], limit: 15 }),
  ]);
  return { term, cases, people, reports, orgs };
}

/**
 * Conflict of interest check: is this person (by name or NRC) already a KDLA client or an
 * other party? Exact matches come first; confidential cases are shown without their heading.
 */
async function conflictCheck(req, params = {}) {
  const name = str(params.name, 120);
  const nrc = str(params.nrc, 20).replace(/\s+/g, '');
  const searched = Boolean(name || nrc);
  let results = [];
  if (searched) {
    const or = [];
    if (name) or.push({ nameKey: nameKey(name, '') });
    if (nrc) or.push({ nrc });
    const exact = await req.db.find('people', { where: { kind: { $in: ['client', 'defendant'] }, $or: or } });
    const partial = name && name.length >= 3
      ? await req.db.find('people', { where: { kind: { $in: ['client', 'defendant'] } }, search: { term: nameKey(name, ''), fields: ['nameKey'] }, limit: 50 })
      : [];
    const seen = new Set();
    for (const p of [...exact, ...partial]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const field = p.kind === 'client' ? 'clientIds' : 'defendantIds';
      const cs = await req.db.find('cases', { where: { [field]: { $contains: p.id } }, fields: ['id', 'caseNumber', 'heading', 'status', 'restricted', 'officerId', 'teamIds'] });
      results.push({ p, exact: exact.some((e) => e.id === p.id), cases: cs.map((c) => (canSeeCase(req.user, c) ? c : { ...c, heading: 'Confidential case', redacted: true })) });
    }
    results = results.sort((a, b) => Number(b.exact) - Number(a.exact));
  }
  return {
    name, nrc, searched, results,
  };
}

module.exports = { searchAll, conflictCheck };
