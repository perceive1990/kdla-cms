'use strict';
const express = require('express');
const svc = require('../services/comments');
const { HttpError } = require('../services/errors');

const router = express.Router();

router.post('/:kind/:id', async (req, res) => {
  try {
    const { t } = await svc.add(req, req.params.kind, req.params.id, req.body.text);
    req.flash('success', 'Comment added.');
    return res.redirect(`${t.url}#comments`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 422) throw e;
    req.flash('danger', e.message);
    const t = await svc.target(req.db, req.params.kind, req.params.id);
    return res.redirect(`${t.url}#comments`);
  }
});

router.post('/:kind/:id/:commentId/delete', async (req, res) => {
  const t = await svc.remove(req, req.params.commentId, req.params.kind, req.params.id);
  req.flash('success', 'Comment deleted.');
  return res.redirect(`${t.url}#comments`);
});

module.exports = router;
