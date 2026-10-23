'use strict';
// Rules for stakeholder organisations, projects and staff accounts, shared by the web pages and the API.
const choices = require('../choices');
const { audit } = require('../audit');
const { hashPassword, passwordProblem } = require('../auth');
const {
  newId, now, str, bool, isRealDate,
} = require('../helpers');
const { HttpError, notFound } = require('./errors');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Stakeholder organisations ----------
function readStakeholder(body) {
  return {
    name: str(body.name, 150),
    description: str(body.description, 3000),
    services: str(body.services, 1000),
    address: str(body.address, 300),
    contactPerson: str(body.contactPerson, 200),
    phone: str(body.phone, 60),
    email: str(body.email, 150),
  };
}

function validateStakeholder(v) {
  const e = {};
  if (!v.name) e.name = 'Enter the name of the organisation.';
  if (!v.contactPerson) e.contactPerson = 'Enter a contact person.';
  if (!v.phone) e.phone = 'Enter a phone number.';
  if (v.email && !EMAIL.test(v.email)) e.email = 'Enter a valid email address.';
  return e;
}

function stakeholderQuery(params = {}) {
  const q = {};
  const term = str(params.q, 80);
  if (term) q.search = { term, fields: ['name', 'description', 'services', 'contactPerson'] };
  return q;
}

async function getStakeholder(db, id) {
  const s = await db.get('stakeholders', id);
  if (!s) throw notFound('Organisation');
  return s;
}

async function createStakeholder(req, v) {
  const doc = { id: newId(), ...v, createdBy: req.user.id, createdAt: now(), updatedAt: now() };
  const saved = await req.db.create('stakeholders', doc);
  audit(req, 'create', 'stakeholders', doc.id, `Added organisation ${doc.name}`);
  return saved;
}

async function updateStakeholder(req, s, v, { ifMatch } = {}) {
  const saved = await req.db.replace('stakeholders', { ...s, ...v, updatedAt: now() }, { ifMatch });
  audit(req, 'update', 'stakeholders', s.id, `Updated organisation ${saved.name}`);
  return saved;
}

async function deleteStakeholder(req, s) {
  const n = await req.db.count('referrals', { where: { organizationId: s.id } });
  if (n > 0) throw new HttpError(409, 'in_use', `${s.name} has ${n} referral(s) and cannot be deleted. Remove those referrals first.`);
  const linked = await req.db.find('reports', { where: { partnerIds: { $contains: s.id } } });
  for (const r of linked) await req.db.replace('reports', { ...r, partnerIds: r.partnerIds.filter((x) => x !== s.id), updatedAt: now() });
  await req.db.remove('stakeholders', s.id);
  audit(req, 'delete', 'stakeholders', s.id, `Deleted organisation ${s.name}`);
}

// ---------- Projects ----------
const CURRENCIES = ['ZMW', 'DKK', 'USD', 'EUR', 'GBP'];

function readProject(body) {
  const budgetRaw = body.budget;
  return {
    title: str(body.title, 200),
    donor: str(body.donor, 200),
    description: str(body.description, 3000),
    startDate: str(body.startDate, 10),
    endDate: str(body.endDate, 10),
    budget: budgetRaw === '' || budgetRaw === undefined || budgetRaw === null ? null : Number(budgetRaw),
    currency: CURRENCIES.includes(body.currency) ? body.currency : 'ZMW',
  };
}

function validateProject(v) {
  const e = {};
  if (!v.title) e.title = 'Enter the project title.';
  if (!isRealDate(v.startDate)) e.startDate = 'Enter a start date.';
  if (!isRealDate(v.endDate)) e.endDate = 'Enter an end date.';
  else if (isRealDate(v.startDate) && v.endDate < v.startDate) e.endDate = 'End date must be after the start date.';
  if (v.budget !== null && (Number.isNaN(v.budget) || v.budget < 0)) e.budget = 'Enter a valid amount.';
  return e;
}

async function getProject(db, id) {
  const p = await db.get('projects', id);
  if (!p) throw notFound('Project');
  return p;
}

async function createProject(req, v) {
  const doc = { id: newId(), ...v, createdAt: now(), updatedAt: now() };
  const saved = await req.db.create('projects', doc);
  audit(req, 'create', 'projects', doc.id, `Added project ${v.title}`);
  return saved;
}

async function updateProject(req, p, v) {
  const saved = await req.db.replace('projects', { ...p, ...v, updatedAt: now() });
  audit(req, 'update', 'projects', p.id, `Updated project ${v.title}`);
  return saved;
}

async function deleteProject(req, p) {
  const used = await req.db.count('people', { where: { projectId: p.id } }) + await req.db.count('reports', { where: { projectId: p.id } });
  if (used) throw new HttpError(409, 'in_use', `${p.title} is linked to ${used} beneficiaries or reports and cannot be deleted.`);
  await req.db.remove('projects', p.id);
  audit(req, 'delete', 'projects', p.id, `Deleted project ${p.title}`);
}

// ---------- Staff accounts ----------
const SECRET_FIELDS = ['passwordHash', 'totpSecret', 'recoveryCodes', 'totpLastStep', 'failedLogins', 'sessionEpoch'];

/** A staff account without passwords or two-step secrets. */
function publicUser(u, { full = false } = {}) {
  if (!u) return null;
  if (!full) return { id: u.id, username: u.username, fullName: u.fullName, role: u.role, office: u.office || '', active: u.active !== false };
  const out = { ...u };
  for (const f of SECRET_FIELDS) delete out[f];
  delete out._etag;
  out.totpEnabled = Boolean(u.totpEnabled);
  return out;
}

function readUser(body) {
  return {
    username: str(body.username, 60).toLowerCase(),
    fullName: str(body.fullName, 150),
    email: str(body.email, 150),
    role: choices.roles.includes(body.role) ? body.role : 'officer',
    category: str(body.category),
    qualification: str(body.qualification),
    office: str(body.office),
    active: body.active === undefined ? true : bool(body.active),
  };
}

async function validateNewUser(db, v, password) {
  const errors = {};
  if (!/^[a-z0-9._-]{3,60}$/.test(v.username)) errors.username = 'Use 3 or more letters, numbers, dots, dashes or underscores.';
  else if ((await db.count('users', { where: { username: v.username } })) > 0) errors.username = 'That username is taken.';
  if (!v.fullName) errors.fullName = 'Enter the full name.';
  if (v.email && !EMAIL.test(v.email)) errors.email = 'Enter a valid email address.';
  const problem = passwordProblem(password, v.username);
  if (problem) errors.password = problem;
  return errors;
}

async function getUser(db, id) {
  const u = await db.get('users', id);
  if (!u) throw notFound('Staff account');
  return u;
}

async function createStaff(req, v, password) {
  const doc = {
    id: newId(), ...v, passwordHash: await hashPassword(password), mustChangePassword: true, sessionEpoch: 0,
    createdAt: now(), updatedAt: now(),
  };
  const saved = await req.db.create('users', doc);
  audit(req, 'create', 'users', doc.id, `Created ${v.role} account ${v.username}`);
  return saved;
}

/**
 * Apply an administrator's changes to a staff account: details, role, active, and optionally
 * a new temporary password, unlocking, or resetting two-step verification.
 * Returns { errors } without saving when something is wrong, otherwise { doc, signOut }.
 * signOut is true when the change ends the person's sessions and API tokens.
 */
async function updateStaff(req, u, v, { password = '', unlock = false, reset2fa = false } = {}) {
  const errors = {};
  const data = { ...v, username: u.username };
  if (!data.fullName) errors.fullName = 'Enter the full name.';
  if (data.email && !EMAIL.test(data.email)) errors.email = 'Enter a valid email address.';
  if (u.id === req.user.id && (data.role !== 'admin' || !data.active)) errors.role = 'You cannot remove your own administrator access.';
  if (password) {
    const problem = passwordProblem(password, u.username);
    if (problem) errors.password = problem;
  }
  if (Object.keys(errors).length) return { errors };

  const patch = {};
  const changes = [];
  if (password) {
    patch.passwordHash = await hashPassword(password);
    patch.mustChangePassword = true;
    changes.push('password reset');
  }
  if (data.role !== u.role) changes.push(`role ${data.role}`);
  if (data.active !== (u.active !== false)) changes.push(data.active ? 'enabled' : 'disabled');
  if (unlock && u.lockedUntil) { patch.lockedUntil = null; patch.failedLogins = 0; changes.push('unlocked'); }
  if (reset2fa && u.totpEnabled) {
    Object.assign(patch, { totpEnabled: false, totpSecret: null, totpLastStep: null, recoveryCodes: [] });
    changes.push('two-step verification reset');
  }
  // Sign the person out everywhere after security-relevant changes.
  const signOut = Boolean(patch.passwordHash || data.role !== u.role || !data.active || patch.totpEnabled === false);
  const doc = await req.db.replace('users', {
    ...u, ...data, ...patch, sessionEpoch: (u.sessionEpoch || 0) + (signOut ? 1 : 0), updatedAt: now(),
  });
  audit(req, 'update', 'users', u.id, `Updated account ${u.username}${changes.length ? `: ${changes.join(', ')}` : ''}`);
  return { doc, signOut, errors: {} };
}

module.exports = {
  readStakeholder, validateStakeholder, stakeholderQuery, getStakeholder, createStakeholder, updateStakeholder, deleteStakeholder,
  readProject, validateProject, getProject, createProject, updateProject, deleteProject, CURRENCIES,
  publicUser, readUser, validateNewUser, createStaff, updateStaff, getUser,
};
