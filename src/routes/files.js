'use strict';
const express = require('express');
const svc = require('../services/attachments');

const router = express.Router();

router.get('/:entity/:id/:fileId', async (req, res) => {
  const found = await svc.findAttachment(req, req.params.entity, req.params.id, req.params.fileId);
  const ok = await svc.sendAttachment(req, res, found, { download: Boolean(req.query.download) });
  if (!ok && !res.headersSent) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('Content-Disposition');
    return res.status(404).render('error', { title: 'Not found', message: 'That file is missing from storage.' });
  }
  return undefined;
});

router.post('/:entity/:id/:fileId/delete', async (req, res) => {
  const found = await svc.findAttachment(req, req.params.entity, req.params.id, req.params.fileId);
  await svc.deleteAttachment(req, found);
  req.flash('success', `Removed ${found.att.name}.`);
  return res.redirect(`/${req.params.entity}/${found.doc.id}`);
});

module.exports = router;
