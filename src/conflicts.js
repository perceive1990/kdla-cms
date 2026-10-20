'use strict';
// Conflict of interest and duplicate checks, as found in most legal case management systems.
// A conflict exists when KDLA would act for one party against someone it also serves as a client.

const PEOPLE_FIELDS = ['id', 'kind', 'firstName', 'lastName', 'nrc', 'nameKey', 'caseNumber', 'contact', 'createdAt'];

/** Normalised "first last" used to match names regardless of case, spacing or punctuation. */
function nameKey(first, last) {
  return `${first || ''} ${last || ''}`
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** People of the given kinds whose name or NRC matches. */
async function findMatches(db, { kinds, keys = [], nrcs = [], excludeIds = [] }) {
  const or = [];
  const k = [...new Set(keys.filter(Boolean))];
  const n = [...new Set(nrcs.filter(Boolean))];
  if (k.length) or.push({ nameKey: { $in: k } });
  if (n.length) or.push({ nrc: { $in: n } });
  if (!or.length) return [];
  const rows = await db.find('people', { where: { kind: { $in: kinds }, $or: or }, fields: PEOPLE_FIELDS });
  return rows.filter((r) => !excludeIds.includes(r.id));
}

/**
 * Checks before registering a person.
 * duplicates: same kind with the same name or NRC (probably already registered).
 * conflicts: a client who is someone else's other party, or an other party who is a KDLA client.
 */
async function checkPerson(db, { kind, firstName, lastName, nrc, selfId }) {
  const keys = [nameKey(firstName, lastName)];
  const nrcs = nrc ? [nrc] : [];
  const excludeIds = selfId ? [selfId] : [];
  const duplicates = await findMatches(db, { kinds: [kind], keys, nrcs, excludeIds });
  let conflicts = [];
  if (kind === 'client') conflicts = await findMatches(db, { kinds: ['defendant'], keys, nrcs, excludeIds });
  if (kind === 'defendant') conflicts = await findMatches(db, { kinds: ['client'], keys, nrcs, excludeIds });
  return { duplicates, conflicts };
}

/**
 * Conflicts on a case: other parties who are also KDLA clients, and clients who are recorded
 * as an other party (they may be on the opposite side in another case).
 */
async function checkCase(db, c, peopleById) {
  const clients = (c.clientIds || []).map((id) => peopleById[id]).filter(Boolean);
  const others = (c.defendantIds || []).map((id) => peopleById[id]).filter(Boolean);
  const alerts = [];
  if (others.length) {
    const asClients = await findMatches(db, {
      kinds: ['client'], keys: others.map((p) => p.nameKey || nameKey(p.firstName, p.lastName)), nrcs: others.map((p) => p.nrc),
    });
    for (const m of asClients) {
      const who = others.find((p) => (p.nrc && p.nrc === m.nrc) || (p.nameKey || nameKey(p.firstName, p.lastName)) === m.nameKey);
      alerts.push({ party: who, match: m, reason: 'is an other party in this case and is also registered as a KDLA client' });
    }
  }
  if (clients.length) {
    const asOthers = await findMatches(db, {
      kinds: ['defendant'], keys: clients.map((p) => p.nameKey || nameKey(p.firstName, p.lastName)), nrcs: clients.map((p) => p.nrc),
    });
    for (const m of asOthers) {
      if ((c.defendantIds || []).includes(m.id)) continue;
      const who = clients.find((p) => (p.nrc && p.nrc === m.nrc) || (p.nameKey || nameKey(p.firstName, p.lastName)) === m.nameKey);
      alerts.push({ party: who, match: m, reason: 'is a client in this case and is also recorded as an other party' });
    }
  }
  return alerts;
}

module.exports = { nameKey, findMatches, checkPerson, checkCase, PEOPLE_FIELDS };
