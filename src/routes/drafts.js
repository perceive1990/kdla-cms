'use strict';
// Offline drafts. Staff who switch this on for their own computer can write activity reports (with the names
// of those who attended) and case notes without internet. The drafts stay in that browser until the
// connection returns, then are sent here and saved like any other report or note. No existing record is
// ever stored on the device: the page below holds only the forms and lists of choices.
const express = require('express');
const choices = require('../choices');
const reports = require('../services/reports');
const cases = require('../services/cases');
const workplans = require('../services/workplans');
const { importRegister } = require('../services/report-register');
const { HttpError } = require('../services/errors');
const { str } = require('../helpers');

const router = express.Router();
const TEXT_FIELDS = ['introduction', 'objectives', 'implementation', 'immediateResults', 'contribution', 'challenges', 'recommendations'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Plain text typed offline → the paragraphs the rich text fields hold. */
const paragraphs = (t) => String(t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

router.get('/', async (req, res) => {
  // Planned activities of the person's offices, to link a report to (titles only, no records).
  const mineOnly = !reports.allOffices(req.user);
  const options = (await workplans.activityOptions(req.db))
    .filter((o) => o.plan.status !== 'Closed' && o.item.status !== 'Cancelled' && (!mineOnly || !o.plan.office || o.plan.office === req.user.office))
    .slice(0, 300)
    .map((o) => ({ value: `${o.plan.id}:${o.item.id}`, label: `${o.plan.title}: ${Number.isInteger(o.item.number) ? `${o.item.number}. ` : ''}${o.item.title}`, office: o.plan.office || '' }));
  res.set('Cache-Control', 'no-store');
  res.render('drafts', {
    title: 'Offline drafts', options, offices: mineOnly ? [req.user.office].filter(Boolean) : choices.offices,
  });
});

/** A fresh form token for sending drafts, and who is signed in (drafts are only sent by their author). */
router.get('/token', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ csrf: res.locals.csrfToken, userId: req.user.id });
});

async function sendReport(req, d, offlineId) {
  const [done] = await req.db.find('reports', { where: { offlineId }, fields: ['id', 'heading'], limit: 1 });
  if (done) return { url: `/reports/${done.id}`, message: `Already sent: "${done.heading}".` };
  const body = {
    activityType: d.activityType, heading: d.heading, date: d.date, office: d.office, location: d.location, district: d.district,
    workplanItem: d.workplanItem || '', otherParticipants: d.otherParticipants, compiledById: req.user.id,
  };
  for (const f of TEXT_FIELDS) body[f] = paragraphs(d[f]);
  const v = reports.readReport(body);
  await reports.settleOffice(req, v);
  const errors = await reports.validateReport(req.db, v);
  if (Object.keys(errors).length) throw new HttpError(422, 'validation', Object.values(errors)[0], { fields: errors });
  const names = String(d.attendees || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let imported = '';
  if (names.length) {
    // The typed names arrive as a register: "Full name, NRC, sex, phone, village or area" on each line.
    const csv = `S/N,Full name,NRC,Sex,Phone,Community\n${names.map((l, i) => `${i + 1},${l}`).join('\n')}\n`;
    imported = await importRegister(req, v, { originalname: 'offline draft register.csv', buffer: Buffer.from(csv, 'utf8') }, { adults: d.adults !== false });
  }
  const doc = await reports.createReport(req, { ...v, offlineId });
  return { url: `/reports/${doc.id}`, message: `Report "${doc.heading}" saved.${imported}` };
}

async function sendNote(req, d, offlineId) {
  const number = str(d.caseNumber, 40).toUpperCase().replace(/\s+/g, '');
  if (!number) throw new HttpError(422, 'validation', 'Enter the case number, for example KDLA/2026/0012.', { fields: { caseNumber: 'Enter the case number.' } });
  const [found] = await req.db.find('cases', { where: { caseNumber: number }, fields: ['id'], limit: 1 });
  if (!found) throw new HttpError(422, 'validation', `No case has the number ${number}. Check it and send again.`, { fields: { caseNumber: 'No case has this number.' } });
  const c = await cases.getCase(req, found.id);
  const [done] = await req.db.find('caseNotes', { where: { caseId: c.id, offlineId }, fields: ['id'], limit: 1 });
  if (done) return { url: `/cases/${c.id}#notes`, message: `Already sent to ${c.caseNumber}.` };
  const n = cases.readNote(d);
  const errors = cases.validateNote(n);
  if (Object.keys(errors).length) throw new HttpError(422, 'validation', Object.values(errors)[0], { fields: errors });
  await cases.addNote(req, c, { ...n, offlineId });
  return { url: `/cases/${c.id}#notes`, message: `Note added to the diary of ${c.caseNumber}.` };
}

router.post('/sync', async (req, res) => {
  const { kind } = req.body || {};
  const offlineId = str(req.body && req.body.offlineId, 60);
  const data = (req.body && typeof req.body.data === 'object' && req.body.data) || {};
  if (!/^[A-Za-z0-9-]{8,60}$/.test(offlineId)) return res.status(400).json({ error: 'The draft has no valid identifier.' });
  try {
    const out = kind === 'note' ? await sendNote(req, data, offlineId) : kind === 'report' ? await sendReport(req, data, offlineId) : null;
    if (!out) return res.status(400).json({ error: 'Unknown kind of draft.' });
    return res.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof HttpError && [403, 404, 422].includes(e.status)) return res.status(e.status).json({ error: e.message, fields: e.details && e.details.fields ? e.details.fields : (e.fields || {}) });
    throw e;
  }
});


module.exports = router;
