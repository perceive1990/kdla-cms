'use strict';
const config = require('./config');
const { newId, now } = require('./helpers');

/**
 * Append-only audit trail of who did what and when. Supports accountability for confidential
 * client records (Zambia Data Protection Act 2021). Writing never blocks or breaks a request.
 *
 * action: login, login_failed, logout, create, update, delete, view, download, export, security
 */
function clientIp(req) {
  const raw = String(req.ip || '');
  // App Service adds the client port to X-Forwarded-For ("1.2.3.4:5678"); strip it for IPv4.
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(raw) ? raw.replace(/:\d+$/, '') : raw;
}

function audit(req, action, entity, entityId, summary, extra = {}) {
  const user = extra.user || req.user;
  const ttl = config.auditRetentionDays > 0 ? config.auditRetentionDays * 86400 : undefined;
  const entry = {
    id: newId(),
    at: now(),
    userId: user ? user.id : null,
    username: user ? user.username : (extra.username || null),
    action,
    entity,
    entityId: entityId || null,
    summary: String(summary || '').slice(0, 300),
    ip: clientIp(req),
  };
  if (String(req.originalUrl || '').startsWith('/api/')) entry.via = 'api';
  if (ttl) entry.ttl = ttl;
  return req.db.create('audit', entry).catch((err) => {
    console.error('Audit write failed:', err.message);
  });
}

module.exports = { audit, clientIp };
