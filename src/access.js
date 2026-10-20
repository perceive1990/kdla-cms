'use strict';
// Who may see which case. Confidential cases (for example GBV) are visible only to the responsible
// officer, the case team and administrators. Everyone else sees that a confidential case exists.

const isAdmin = (user) => Boolean(user && user.role === 'admin');

/** Query condition limiting cases to those the user may see. */
function caseFilter(user) {
  if (isAdmin(user)) return {};
  return {
    $or: [
      { restricted: { $notTrue: true } },
      { officerId: user.id },
      { teamIds: { $contains: user.id } },
    ],
  };
}

/** Combine extra conditions with the visibility rule. */
function visibleWhere(user, where = {}) {
  const f = caseFilter(user);
  if (!Object.keys(f).length) return where;
  return { $and: [where, f] };
}

function canSeeCase(user, c) {
  if (!c || !user) return false;
  if (isAdmin(user) || c.restricted !== true) return true;
  return c.officerId === user.id || (c.teamIds || []).includes(user.id);
}

/** A placeholder shown instead of a confidential case the user may not open. */
function redact(c) {
  return {
    id: c.id, caseNumber: c.caseNumber, heading: 'Confidential case', status: c.status,
    restricted: true, redacted: true, officerId: c.officerId,
  };
}

function visibleCase(user, c) {
  if (!c) return c;
  return canSeeCase(user, c) ? c : redact(c);
}

/** Apply visibleCase to every value of an id -> case map. */
function visibleMap(user, map) {
  const out = {};
  for (const [id, c] of Object.entries(map || {})) out[id] = visibleCase(user, c);
  return out;
}

module.exports = { isAdmin, caseFilter, visibleWhere, canSeeCase, visibleCase, visibleMap, redact };
