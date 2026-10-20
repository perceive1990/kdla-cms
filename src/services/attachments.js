'use strict';
// Files attached to cases and activity reports, shared by the web pages and the API.
const { getStorage, safeName } = require('../storage');
const { canSeeCase } = require('../access');
const { audit } = require('../audit');
const { newId, now } = require('../helpers');
const { HttpError, notFound } = require('./errors');

const ENTITIES = { cases: 'cases', reports: 'reports' };

/** Save uploaded files (from multer) and return attachment records. */
async function saveUploads(files, user) {
  const out = [];
  for (const f of files || []) {
    if (!f.size) continue;
    const key = await getStorage().save(f);
    out.push({
      id: newId(), key, name: safeName(f.originalname), size: f.size, type: f.mimetype,
      uploadedAt: now(), uploadedBy: user.id,
    });
  }
  return out;
}

async function removeAttachments(list) {
  for (const a of list || []) await getStorage().remove(a.key);
}

/**
 * Find one attachment on a case or report the user may open.
 * entity is "cases" or "reports". Returns { container, doc, att }.
 */
async function findAttachment(req, entity, id, fileId) {
  const container = ENTITIES[entity];
  if (!container) throw notFound('File');
  const doc = await req.db.get(container, id);
  if (!doc) throw notFound('File');
  if (container === 'cases' && !canSeeCase(req.user, doc)) {
    throw new HttpError(403, 'confidential', 'This file belongs to a confidential case. You do not have access to it.');
  }
  const att = (doc.attachments || []).find((a) => a.id === fileId);
  if (!att) throw notFound('File');
  return { container, doc, att };
}

/** Send the file to the browser or API client. Returns false when the stored file is missing. */
async function sendAttachment(req, res, { container, doc, att }, { download = false } = {}) {
  // The page security policy is for HTML pages; on files it can stop the browser's PDF viewer.
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Type', att.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${att.name}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  audit(req, 'download', container, doc.id, `Opened file ${att.name}`);
  return getStorage().stream(att.key, res);
}

/** Add newly uploaded files to a case or report. */
async function addAttachments(req, container, doc, list, { ifMatch } = {}) {
  if (!list.length) return doc;
  const saved = await req.db.replace(container, { ...doc, attachments: [...(doc.attachments || []), ...list], updatedAt: now() }, { ifMatch });
  audit(req, 'update', container, doc.id, `Attached ${list.map((a) => a.name).join(', ')}`);
  return saved;
}

async function deleteAttachment(req, { container, doc, att }, { ifMatch } = {}) {
  const saved = await req.db.replace(container, { ...doc, attachments: doc.attachments.filter((a) => a.id !== att.id), updatedAt: now() }, { ifMatch });
  await getStorage().remove(att.key);
  audit(req, 'delete', container, doc.id, `Removed file ${att.name}`);
  return saved;
}

/** Attachment as shown to API clients (the storage key stays private). */
function publicAttachment(a, base) {
  return {
    id: a.id, name: a.name, size: a.size, type: a.type, uploadedAt: a.uploadedAt, uploadedBy: a.uploadedBy,
    downloadUrl: `${base}/attachments/${a.id}`,
  };
}

module.exports = {
  ENTITIES, saveUploads, removeAttachments, findAttachment, sendAttachment, addAttachments, deleteAttachment, publicAttachment,
};
