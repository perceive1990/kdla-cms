'use strict';
// Small helpers for consistent API responses: errors, paging, sorting, version tags (ETags).
const { HttpError } = require('../services/errors');
const { publicAttachment } = require('../services/attachments');

const BASE = '/api/v1';

/** 422 with one message per field, e.g. { heading: 'Enter a heading.' }. */
function invalid(fields, message = 'Some fields need attention. See "fields" for details.') {
  return new HttpError(422, 'validation_failed', message, { fields });
}

function failIfInvalid(errors) {
  if (errors && Object.keys(errors).length) throw invalid(errors);
}

/**
 * Values outside the option lists. The web forms cannot send these, but an API client can,
 * and they must be reported rather than quietly dropped. rules: { field: allowedValues }.
 */
function checkChoices(body, rules) {
  const errors = {};
  for (const [field, allowed] of Object.entries(rules)) {
    if (body[field] === undefined || body[field] === null) continue;
    const values = (Array.isArray(body[field]) ? body[field] : [body[field]]).map(String);
    const bad = values.filter((v) => v !== '' && !allowed.includes(v));
    if (bad.length) errors[field] = `Not a valid choice: ${bad.join(', ')}. GET /api/v1/choices lists the options.`;
  }
  return errors;
}

// ---------- Version tags (optimistic concurrency) ----------
const quoteTag = (tag) => (/^(W\/)?"/.test(String(tag)) ? String(tag) : `"${tag}"`);
const bareTag = (tag) => String(tag || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/**
 * Compare an If-Match header with the record's current version.
 * Throws 412 when they differ. No header (or "*") means "save whatever the current version is".
 */
function checkIfMatch(req, doc) {
  const sent = req.get('if-match');
  if (!sent || sent.trim() === '*') return;
  const tags = sent.split(',').map(bareTag);
  if (!tags.includes(bareTag(doc._etag))) {
    throw new HttpError(412, 'precondition_failed', 'This record was changed by someone else after you read it. Fetch it again, then reapply your changes.');
  }
}

/**
 * Run load, change and save. If another change lands between our read and our write, the database
 * refuses the write (412); when the client did not send If-Match the whole step is repeated on
 * fresh data, so two clients changing different fields never overwrite each other.
 */
async function saveWithRetry(req, step) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (err) {
      const conflict = err && err.code === 412 && !(err instanceof HttpError);
      if (!conflict || req.get('if-match') || attempt >= 3) throw err;
    }
  }
}

// ---------- Paging and sorting ----------
function pageParams(req, maxPageSize = 100) {
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** ?sort=field or ?sort=-field (newest first), limited to fields every record has. */
function sortParam(req, allowed, fallback) {
  const raw = String(req.query.sort || '');
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  return allowed.includes(field) ? [field, desc ? 'DESC' : 'ASC'] : fallback;
}

/** One page of a container query: { rows, meta } where meta is { page, pageSize, total, pages }. */
async function findPage(req, container, q, orderBy) {
  const { page, pageSize, offset } = pageParams(req);
  const total = await req.db.count(container, q);
  const rows = await req.db.find(container, { ...q, orderBy, offset, limit: pageSize });
  return { rows, meta: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } };
}

/** Page through an array that is already in memory. */
function pageOf(req, list) {
  const { page, pageSize, offset } = pageParams(req);
  return {
    rows: list.slice(offset, offset + pageSize),
    meta: { page, pageSize, total: list.length, pages: Math.max(1, Math.ceil(list.length / pageSize)) },
  };
}

// ---------- Output ----------
const SYSTEM_FIELDS = ['_etag', '_rid', '_self', '_attachments', '_ts', 'ttl'];

/** A record without database system fields, with its version tag as "etag". */
function present(doc, omit = []) {
  if (!doc) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!SYSTEM_FIELDS.includes(k) && !omit.includes(k)) out[k] = v;
  if (doc._etag) out.etag = quoteTag(doc._etag);
  return out;
}

/** Cases and reports: attachments without their storage keys, with download links. */
function presentWithFiles(doc, kind) {
  const out = present(doc);
  if (out && Array.isArray(out.attachments)) out.attachments = out.attachments.map((a) => publicAttachment(a, `${BASE}/${kind}/${doc.id}`));
  return out;
}

const presentPerson = (p) => present(p, ['nameKey']);

/** Send one record with its ETag header. */
function sendOne(res, doc, status = 200, location) {
  if (doc && doc.etag) res.set('ETag', doc.etag);
  if (location) res.set('Location', location);
  return res.status(status).json(doc);
}

const sendList = (res, data, meta) => res.json({ data, ...meta });

module.exports = {
  BASE, invalid, failIfInvalid, checkChoices, checkIfMatch, saveWithRetry, quoteTag, bareTag,
  pageParams, sortParam, findPage, pageOf, present, presentWithFiles, presentPerson, sendOne, sendList,
};
