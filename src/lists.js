'use strict';
// Drop-down lists that administrators can change in the app (Administration > Drop-down lists).
// The saved lists are kept in the database and copied into src/choices.js at start-up and after
// every change, so every page, check and statistic uses the same values.
const choices = require('./choices');
const { audit } = require('./audit');
const { now } = require('./helpers');

const EDITABLE = {
  districts: { label: 'Districts', used: [['reports', 'district', 'activity reports']] },
  offices: { label: 'Offices', used: [['cases', 'office', 'cases'], ['users', 'office', 'staff accounts']] },
};
const DOC_ID = 'lists';

function apply(key, values) {
  choices[key].splice(0, choices[key].length, ...values);
}

/** Copy the saved lists into the choices used by the app. */
async function loadLists(db) {
  const doc = await db.get('meta', DOC_ID);
  for (const key of Object.keys(EDITABLE)) {
    if (doc && Array.isArray(doc[key]) && doc[key].length) apply(key, doc[key]);
  }
}

/** One value per line; blank lines and repeats are ignored. Returns { values } or { error }. */
function parseList(text) {
  const values = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = line.trim().replace(/\s+/g, ' ');
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) values.push(v);
  }
  if (!values.length) return { error: 'Keep at least one entry.' };
  const long = values.find((v) => v.length > 100);
  if (long) return { error: `"${long.slice(0, 30)}…" is longer than 100 characters.` };
  if (values.length > 200) return { error: 'Keep the list to 200 entries or fewer.' };
  return { values };
}

/** How many records use each value, so an administrator can see what a removal affects. */
async function usage(db, key) {
  const counts = {};
  for (const [container, field] of EDITABLE[key].used) {
    const rows = await db.find(container, { fields: [field] });
    for (const r of rows) if (r[field]) counts[r[field]] = (counts[r[field]] || 0) + 1;
  }
  return counts;
}

async function saveList(req, key, values) {
  const before = [...choices[key]];
  const doc = (await req.db.get('meta', DOC_ID)) || { id: DOC_ID };
  await req.db.upsert('meta', { ...doc, [key]: values, updatedAt: now(), updatedBy: req.user.id });
  apply(key, values);
  const added = values.filter((v) => !before.includes(v));
  const removed = before.filter((v) => !values.includes(v));
  const parts = [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean);
  audit(req, 'update', 'meta', DOC_ID, `${EDITABLE[key].label}: ${parts.join('; ') || 'reordered'}`);
  return { added, removed };
}

module.exports = {
  EDITABLE, loadLists, parseList, usage, saveList,
};
