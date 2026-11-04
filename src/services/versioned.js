'use strict';
// Saving documents that several colleagues change at the same time (work plans, logframes).
const { now } = require('../helpers');

const changedMeanwhile = () => Object.assign(new Error('Precondition failed'), { code: 412 });

/**
 * Save a change to a document. `change` receives the latest copy and returns the new one. If someone
 * else saves the document in between, the change is applied again to a fresh copy from `reload`, so two
 * people changing different parts at the same moment never overwrite each other. With `ifMatch` (the
 * version the person read) the save is refused with 412 instead when the document has changed since.
 */
async function saveLatest(db, container, doc, change, { ifMatch, reload } = {}) {
  let current = doc;
  for (let attempt = 1; ; attempt += 1) {
    if (ifMatch && current._etag !== ifMatch) throw changedMeanwhile();
    const next = { ...change(current), updatedAt: now() };
    try {
      return await db.replace(container, next, { ifMatch: current._etag });
    } catch (err) {
      if (err.code !== 412 || ifMatch || attempt >= 3 || !reload) throw err;
      current = await reload();
    }
  }
}

module.exports = { saveLatest, changedMeanwhile };
