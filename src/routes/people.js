'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { visibleCase } = require('../access');
const { findMatches } = require('../conflicts');
const svc = require('../services/people');
const { notFound } = require('../services/errors');
const {
  str, mapByIds, pagination, toCsv, sendCsv, fullName, fmtDate, today,
} = require('../helpers');

const router = express.Router();
const { KIND_LABEL, SLUG_OF } = svc;

// Clients, defendants (other parties) and activity attendees are all "direct beneficiaries".
const KINDS = {
  clients: { kind: 'client', label: 'Client', plural: 'Clients', icon: 'person-vcard' },
  defendants: { kind: 'defendant', label: 'Other party', plural: 'Other parties (defendants)', icon: 'person-x' },
  attendees: { kind: 'attendee', label: 'Activity attendee', plural: 'Activity attendees', icon: 'people' },
};

function kindOf(req) {
  return KINDS[req.params.kind] ? { slug: req.params.kind, ...KINDS[req.params.kind] } : null;
}

async function formLists(db) {
  const [projects, clients] = await Promise.all([
    db.find('projects', { fields: ['id', 'title'], orderBy: ['title', 'ASC'] }),
    db.find('people', { where: { kind: 'client' }, fields: ['id', 'firstName', 'lastName'], orderBy: ['lastName', 'ASC'] }),
  ]);
  return { projects, clients };
}

/** Render the form, listing possible duplicates or conflicts for the user to confirm when there are any. */
function renderForm(res, status, data) {
  return res.status(status).render('people/form', { matches: null, ...data });
}

/** The kind from the address and the person, or a 404 when either is wrong. */
async function load(req) {
  const k = kindOf(req);
  if (!k) throw notFound('Person');
  const p = await svc.getPerson(req.db, req.params.id, k.kind);
  return { k, p };
}

// All direct beneficiaries (every kind)
router.get('/', async (req, res) => {
  const q = svc.peopleQuery(req.query);
  const total = await req.db.count('people', q);
  const pg = pagination(req, total);
  const people = await req.db.find('people', { ...q, orderBy: ['createdAt', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const projects = await req.db.find('projects', { fields: ['id', 'title'] });
  res.render('people/list', {
    title: 'Direct beneficiaries', k: null, people, pg, projects, KIND_LABEL, SLUG_OF,
  });
});

async function sendPeopleCsv(req, res, k) {
  const people = await req.db.find('people', { ...svc.peopleQuery(req.query, k && k.kind), orderBy: ['createdAt', 'ASC'] });
  const projects = await mapByIds(req.db, 'projects', people.map((p) => p.projectId));
  const csv = toCsv([
    { label: 'Type', value: (p) => KIND_LABEL[p.kind] },
    { label: 'First name', value: 'firstName' },
    { label: 'Last name', value: 'lastName' },
    { label: 'NRC', value: 'nrc' },
    { label: 'Contact', value: 'contact' },
    { label: 'Age', value: 'age' },
    { label: 'Age category', value: 'ageCategory' },
    { label: 'Civil status', value: 'civilStatus' },
    { label: 'Disability', value: 'disability' },
    { label: 'Village or area', value: 'location' },
    { label: 'Project', value: (p) => (projects[p.projectId] ? projects[p.projectId].title : '') },
    { label: 'Client file number', value: 'caseNumber' },
    { label: 'Heard about KDLA through', value: 'referralSource' },
    { label: 'Activity', value: 'activity' },
    { label: 'Consent to record', value: 'consentRecord' },
    { label: 'Consent to share on referral', value: 'consentShare' },
    { label: 'Date registered', value: (p) => fmtDate(p.createdAt) },
  ], people);
  audit(req, 'export', 'people', null, `Exported ${people.length} ${k ? k.slug : 'beneficiaries'} to CSV`);
  sendCsv(res, `${k ? k.slug : 'beneficiaries'}-${today()}.csv`, csv);
}

router.get('/export.csv', async (req, res) => sendPeopleCsv(req, res, null));
router.get('/:kind/export.csv', async (req, res, next) => {
  const k = kindOf(req);
  if (!k) return next();
  return sendPeopleCsv(req, res, k);
});

router.get('/:kind', async (req, res, next) => {
  const k = kindOf(req);
  if (!k) return next();
  const q = svc.peopleQuery(req.query, k.kind);
  const total = await req.db.count('people', q);
  const pg = pagination(req, total);
  const people = await req.db.find('people', { ...q, orderBy: ['createdAt', 'DESC'], offset: pg.offset, limit: pg.pageSize });
  const projects = await req.db.find('projects', { fields: ['id', 'title'] });
  return res.render('people/list', { title: k.plural, k, people, pg, projects, KIND_LABEL, SLUG_OF });
});

router.get('/:kind/new', async (req, res, next) => {
  const k = kindOf(req);
  if (!k) return next();
  const values = { versusClientId: str(req.query.client) };
  return renderForm(res, 200, { title: `Add ${k.label.toLowerCase()}`, k, values, errors: {}, isNew: true, ...(await formLists(req.db)) });
});

router.post('/:kind', async (req, res, next) => {
  const k = kindOf(req);
  if (!k) return next();
  const v = svc.readPerson(req.body, k.kind);
  const errors = await svc.validatePerson(req.db, v, k.kind);
  const formData = async (extra) => ({
    title: `Add ${k.label.toLowerCase()}`, k, values: { ...v, then: str(req.body.then) }, errors, isNew: true, ...(await formLists(req.db)), ...extra,
  });
  if (Object.keys(errors).length) return renderForm(res, 400, await formData());

  // Possible duplicates and conflicts of interest must be looked at before saving.
  const { doc, matches } = await svc.createPerson(req, k.kind, v, { confirm: req.body.confirmMatches === 'yes' });
  if (!doc) return renderForm(res, 409, await formData({ matches }));
  req.flash('success', `${k.label} ${fullName(doc)} added.`);
  if (req.body.then === 'case' && k.kind === 'client') return res.redirect(`/cases/new?client=${doc.id}`);
  return res.redirect(`/people/${k.slug}/${doc.id}`);
});

router.get('/:kind/:id', async (req, res) => {
  const { k, p } = await load(req);
  let cases = []; let reports = []; let opponents = []; let versus = null;
  if (k.kind === 'client') {
    cases = await req.db.find('cases', { where: { clientIds: { $contains: p.id } }, orderBy: ['openedOn', 'DESC'] });
    opponents = await req.db.find('people', { where: { kind: 'defendant', versusClientId: p.id } });
  }
  if (k.kind === 'defendant') {
    cases = await req.db.find('cases', { where: { defendantIds: { $contains: p.id } }, orderBy: ['openedOn', 'DESC'] });
    versus = p.versusClientId ? await req.db.get('people', p.versusClientId) : null;
  }
  if (k.kind === 'attendee') {
    reports = await req.db.find('reports', { where: { attendeeIds: { $contains: p.id } }, orderBy: ['date', 'DESC'] });
  }
  cases = cases.map((c) => visibleCase(req.user, c));
  // Same person on the other side? (conflict of interest)
  const otherKind = { client: ['defendant'], defendant: ['client'], attendee: [] }[k.kind];
  const alsoAs = otherKind.length
    ? await findMatches(req.db, { kinds: otherKind, keys: [p.nameKey], nrcs: [p.nrc], excludeIds: [p.id] })
    : [];
  const project = p.projectId ? await req.db.get('projects', p.projectId) : null;
  const users = await mapByIds(req.db, 'users', [p.addedBy, p.consentBy]);
  return res.render('people/show', {
    title: fullName(p), k, p, cases, reports, opponents, versus, project, users, alsoAs, SLUG_OF, KIND_LABEL,
  });
});

// Everything held about one person, for a data subject access request (Data Protection Act 2021).
router.get('/:kind/:id/data.json', requireAdmin, async (req, res) => {
  const { p } = await load(req);
  const data = await svc.personalData(req, p);
  res.setHeader('Content-Disposition', `attachment; filename="personal-data-${p.lastName || 'record'}-${today()}.json"`);
  res.json(data);
});

router.get('/:kind/:id/edit', async (req, res) => {
  const { k, p } = await load(req);
  return renderForm(res, 200, { title: `Edit ${fullName(p)}`, k, values: p, errors: {}, isNew: false, ...(await formLists(req.db)) });
});

router.post('/:kind/:id', async (req, res) => {
  const { k, p } = await load(req);
  const v = svc.readPerson(req.body, k.kind);
  const errors = await svc.validatePerson(req.db, v, k.kind, p.id);
  const formData = async (extra) => ({
    title: `Edit ${fullName(p)}`, k, values: { ...p, ...v }, errors, isNew: false, ...(await formLists(req.db)), ...extra,
  });
  if (Object.keys(errors).length) return renderForm(res, 400, await formData());
  const { doc, matches } = await svc.updatePerson(req, p, v, { confirm: req.body.confirmMatches === 'yes', ifMatch: req.body._etag });
  if (!doc) return renderForm(res, 409, await formData({ matches }));
  req.flash('success', 'Details updated.');
  return res.redirect(`/people/${k.slug}/${p.id}`);
});

router.post('/:kind/:id/delete', requireAdmin, async (req, res) => {
  const { k, p } = await load(req);
  await svc.deletePerson(req, p);
  req.flash('success', `${fullName(p)} deleted.`);
  return res.redirect(`/people/${k.slug}`);
});

module.exports = router;
