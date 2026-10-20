'use strict';
// Audit trail search and the full data export, shared by the web pages and the API.
const config = require('../config');
const containers = require('../db/containers');
const { audit } = require('../audit');
const { now, isRealDate } = require('../helpers');
const { publicUser } = require('./directory');

const ACTIONS = ['login', 'login_failed', 'logout', 'create', 'update', 'delete', 'view', 'download', 'export', 'security'];
const HIDDEN = ['sessions', 'meta', 'audit', 'apiTokens'];
const AUDIT_ENTITIES = Object.keys(containers).filter((c) => !HIDDEN.includes(c));

/** Audit trail filters: action, userId, entity, entityId, from, to (dates). */
function auditQuery(params = {}) {
  const where = {};
  if (ACTIONS.includes(params.action)) where.action = params.action;
  if (params.userId) where.userId = String(params.userId).slice(0, 60);
  if (params.entity && (containers[params.entity] || ['statistics', 'all'].includes(params.entity))) where.entity = params.entity;
  if (params.entityId) where.entityId = String(params.entityId).slice(0, 80);
  if (isRealDate(params.from)) where.at = { $gte: params.from };
  if (isRealDate(params.to)) where.at = { ...(where.at || {}), $lte: `${params.to}T23:59:59.999Z` };
  return { where };
}

/** Number of records of each type, for the export page. */
async function recordCounts(db) {
  const counts = {};
  for (const name of Object.keys(containers)) {
    if (HIDDEN.includes(name)) continue;
    counts[name] = await db.count(name, {});
  }
  return counts;
}

/** Every record (without passwords, two-step secrets or API tokens), for backups and data portability. */
async function exportAll(req) {
  const out = {
    exportedAt: now(), exportedBy: req.user.username, organisation: config.orgFullName,
    note: 'Password hashes, two-step secrets and API tokens are excluded.',
  };
  let types = 0;
  for (const name of Object.keys(containers)) {
    if (HIDDEN.includes(name)) continue;
    let rows = await req.db.find(name, {});
    if (name === 'users') rows = rows.map((u) => publicUser(u, { full: true }));
    out[name] = rows;
    types += 1;
  }
  audit(req, 'export', 'all', null, `Full data export (${types} record types)`);
  return out;
}

module.exports = {
  ACTIONS, AUDIT_ENTITIES, auditQuery, recordCounts, exportAll,
};
