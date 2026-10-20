'use strict';
// File attachments on cases and activity reports: list, upload (multipart/form-data), download, delete.
const multer = require('multer');
const config = require('../config');
const { ALLOWED_TYPES } = require('../middleware');
const att = require('../services/attachments');
const { HttpError, notFound } = require('../services/errors');
const {
  BASE, invalid, saveWithRetry,
} = require('./http');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxFileMb * 1024 * 1024, files: 5, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.test(file.mimetype)) return cb(null, true);
    return cb(new HttpError(415, 'file_type_not_allowed', `File type not allowed: ${file.originalname}. Use PDF, images, Word, Excel, OpenDocument, text, CSV or zip files.`));
  },
}).array('files', 5);

/**
 * Add the attachment routes for one kind of record.
 * kind: "cases" or "reports"; load(req) returns the record after checking the user may see it.
 */
function attachmentRoutes(router, kind, load) {
  const base = (doc) => `${BASE}/${kind}/${doc.id}`;

  router.get(`/${kind}/:id/attachments`, async (req, res) => {
    const doc = await load(req);
    res.json({ data: (doc.attachments || []).map((a) => att.publicAttachment(a, base(doc))) });
  });

  // Access is checked before the upload is read, so nobody can make the server buffer files for a record they cannot open.
  router.post(`/${kind}/:id/attachments`, async (req, res, next) => {
    await load(req);
    if (!req.is('multipart/form-data')) throw new HttpError(415, 'unsupported_media_type', 'Upload files as multipart/form-data in a field called "files".');
    return upload(req, res, next);
  }, async (req, res) => {
    const files = (req.files || []).filter((f) => f.size);
    if (!files.length) throw invalid({ files: 'Attach at least one file in a form field called "files".' });
    const list = await att.saveUploads(files, req.user);
    const saved = await saveWithRetry(req, async () => {
      const fresh = await load(req);
      return att.addAttachments(req, kind, fresh, list, { ifMatch: fresh._etag });
    });
    res.status(201).json({ data: list.map((a) => att.publicAttachment(a, base(saved))) });
  });

  router.get(`/${kind}/:id/attachments/:fileId`, async (req, res) => {
    await load(req);
    const found = await att.findAttachment(req, kind, req.params.id, req.params.fileId);
    const ok = await att.sendAttachment(req, res, found, { download: true });
    if (!ok && !res.headersSent) {
      res.removeHeader('Content-Disposition');
      throw notFound('File');
    }
  });

  router.delete(`/${kind}/:id/attachments/:fileId`, async (req, res) => {
    await load(req);
    await saveWithRetry(req, async () => {
      const found = await att.findAttachment(req, kind, req.params.id, req.params.fileId);
      return att.deleteAttachment(req, found, { ifMatch: found.doc._etag });
    });
    res.status(204).end();
  });
}

module.exports = { attachmentRoutes, upload };
