'use strict';
// Comments on activity reports, work plans and logframes. Every signed-in user can comment, read-only users
// included, so board members and partners can give feedback without changing the records. People delete
// their own comments; administrators can delete any.
const { audit } = require('../audit');
const { newId, now, str } = require('../helpers');
const { forbidden, notFound, HttpError } = require('./errors');

const TARGETS = {
  reports: { label: 'activity report', url: (id) => `/reports/${id}`, name: (d) => d.heading },
  workplans: { label: 'work plan', url: (id) => `/workplans/${id}`, name: (d) => d.title },
  logframes: { label: 'logframe', url: (id) => `/logframes/${id}`, name: (d, p) => (p ? p.title : 'logframe') },
};
const MAX = 2000;
const isAdmin = (u) => Boolean(u && u.role === 'admin');

/** The record being commented on, with where it lives. Logframes are keyed by their project id. */
async function target(db, kind, id) {
  const t = TARGETS[kind];
  if (!t || !id) throw notFound('Record');
  const doc = await db.get(kind, String(id));
  if (!doc) throw notFound('Record');
  const project = kind === 'logframes' ? await db.get('projects', doc.id) : null;
  return { kind, id: doc.id, url: t.url(doc.id), label: t.label, name: t.name(doc, project) };
}

async function list(db, kind, id) {
  return db.find('comments', { where: { targetId: String(id), target: kind }, orderBy: ['createdAt', 'ASC'] });
}

async function add(req, kind, id, text) {
  const t = await target(req.db, kind, id);
  const body = str(text, MAX + 1);
  if (!body) throw new HttpError(422, 'validation', 'Write a comment first.');
  if (body.length > MAX) throw new HttpError(422, 'validation', `Keep comments under ${MAX} characters.`);
  const doc = await req.db.create('comments', {
    id: newId(), target: kind, targetId: t.id, text: body, authorId: req.user.id, authorName: req.user.fullName || req.user.username, createdAt: now(),
  });
  audit(req, 'create', 'comments', doc.id, `Comment on ${t.label} "${t.name}"`);
  return { doc, t };
}

async function remove(req, id, kind, targetId) {
  const [c] = await req.db.find('comments', { where: { id: String(id), targetId: String(targetId) }, limit: 1 });
  if (!c || c.target !== kind) throw notFound('Comment');
  if (c.authorId !== req.user.id && !isAdmin(req.user)) throw forbidden('You can only delete your own comments.');
  await req.db.remove('comments', c.id, c.targetId);
  const t = await target(req.db, kind, targetId);
  audit(req, 'delete', 'comments', c.id, `Deleted a comment on ${t.label} "${t.name}"`);
  return t;
}

/** Puts a record's comments on the page for the comments panel. */
async function attach(req, res, kind, id) {
  res.locals.comments = { kind, id, items: await list(req.db, kind, id) };
}

module.exports = {
  TARGETS, MAX, target, list, add, remove, attach,
};
