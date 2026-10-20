'use strict';
// Cosmos DB containers. All live in one database that shares the free-tier 1000 RU/s
// (a shared-throughput database can hold up to 25 containers).
// pk = partition key field. Most containers are small and keyed on /id for cheap point reads.
module.exports = {
  users: { pk: 'id' },
  projects: { pk: 'id' },
  people: { pk: 'id' }, // clients, defendants and activity attendees (field "kind")
  cases: { pk: 'id' },
  caseNotes: { pk: 'caseId' }, // case diary entries, read per case
  tasks: { pk: 'id' }, // tasks, deadlines, hearings and appointments
  reports: { pk: 'id' },
  stakeholders: { pk: 'id' },
  referrals: { pk: 'id' }, // follow-ups are embedded in each referral
  rooms: { pk: 'id' },
  messages: { pk: 'roomId' },
  audit: { pk: 'id', ttl: true }, // audit trail; entries expire after AUDIT_RETENTION_DAYS
  meta: { pk: 'id' }, // counters (case numbers)
  sessions: { pk: 'id', ttl: true },
  apiTokens: { pk: 'id', ttl: true }, // API tokens (only a SHA-256 hash of each token is stored)
};
