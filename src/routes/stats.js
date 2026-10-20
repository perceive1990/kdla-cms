'use strict';
// Statistics page and CSV export. The figures themselves are worked out in services/stats.js,
// so the API returns exactly the same numbers.
const express = require('express');
const { audit } = require('../audit');
const { period, compute, statsRows } = require('../services/stats');
const { toCsv, sendCsv } = require('../helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const p = period(req.query);
  const projects = await req.db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] });
  const s = p.from <= p.to ? await compute(req.db, p) : null;
  res.render('stats', { title: 'Statistics', p, s, projects });
});

router.get('/export.csv', async (req, res) => {
  const p = period(req.query);
  const s = await compute(req.db, p);
  audit(req, 'export', 'statistics', null, `Exported statistics ${p.from} to ${p.to}`);
  sendCsv(res, `statistics-${p.from}-to-${p.to}.csv`, toCsv([
    { label: 'Section', value: 'section' }, { label: 'Item', value: 'item' }, { label: 'Value', value: 'value' },
  ], statsRows(p, s)));
});

module.exports = router;
