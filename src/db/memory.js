'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const containersDef = require('./containers');
const { matches } = require('./query');

/**
 * In-memory driver with the same interface as the Cosmos driver.
 * Used for local development and automated tests. Set MEMORY_DB_FILE to keep data between restarts.
 * Not for production.
 */
class MemoryDriver {
  constructor({ file } = {}) {
    this.file = file;
    this.data = {};
    for (const name of Object.keys(containersDef)) this.data[name] = new Map();
  }

  async init() {
    if (this.file && fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [name, docs] of Object.entries(raw)) {
        if (!this.data[name]) continue;
        for (const d of docs) this.data[name].set(this._key(name, d.id, d[containersDef[name].pk]), d);
      }
    }
  }

  _key(name, id, pk) {
    return `${pk === undefined ? id : pk}::${id}`;
  }

  _persist() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const out = {};
      for (const [name, map] of Object.entries(this.data)) {
        if (name === 'sessions') continue;
        out[name] = [...map.values()];
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    }, 200);
  }

  async create(name, doc) {
    const d = clone(doc);
    const key = this._key(name, d.id, d[containersDef[name].pk]);
    if (this.data[name].has(key)) throw Object.assign(new Error('Conflict'), { code: 409 });
    d._etag = crypto.randomUUID();
    this.data[name].set(key, d);
    this._persist();
    return clone(d);
  }

  async upsert(name, doc) {
    const d = clone(doc);
    d._etag = crypto.randomUUID();
    this.data[name].set(this._key(name, d.id, d[containersDef[name].pk]), d);
    this._persist();
    return clone(d);
  }

  async get(name, id, pk) {
    if (!id) return null;
    const d = this.data[name].get(this._key(name, String(id), pk === undefined ? String(id) : pk));
    return d ? clone(d) : null;
  }

  async replace(name, doc, { ifMatch } = {}) {
    const key = this._key(name, doc.id, doc[containersDef[name].pk]);
    const existing = this.data[name].get(key);
    if (!existing) throw Object.assign(new Error('Not found'), { code: 404 });
    if (ifMatch && existing._etag !== ifMatch) throw Object.assign(new Error('Precondition failed'), { code: 412 });
    const d = clone(doc);
    delete d._etag;
    d._etag = crypto.randomUUID();
    this.data[name].set(key, d);
    this._persist();
    return clone(d);
  }

  async remove(name, id, pk) {
    const ok = this.data[name].delete(this._key(name, String(id), pk === undefined ? String(id) : pk));
    this._persist();
    return ok;
  }

  _filter(name, q) {
    return [...this.data[name].values()].filter((d) => matches(d, q));
  }

  async find(name, q = {}) {
    let rows = this._filter(name, q);
    if (q.orderBy) {
      const [f, dir] = q.orderBy;
      const sign = String(dir).toUpperCase() === 'ASC' ? 1 : -1;
      rows = rows.filter((r) => r[f] !== undefined);
      rows.sort((a, b) => (a[f] > b[f] ? sign : a[f] < b[f] ? -sign : 0));
    }
    if (q.limit) rows = rows.slice(Number(q.offset) || 0, (Number(q.offset) || 0) + Number(q.limit));
    return rows.map((r) => {
      if (q.fields && q.fields.length) {
        const o = {};
        for (const f of q.fields) if (r[f] !== undefined) o[f] = clone(r[f]);
        return o;
      }
      return strip(clone(r));
    });
  }

  async count(name, q = {}) {
    return this._filter(name, q).length;
  }

  async nextSequence(key) {
    const cur = (await this.get('meta', key)) || { id: key, value: 0 };
    cur.value += 1;
    await this.upsert('meta', cur);
    return cur.value;
  }
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function strip(d) {
  const { _etag, ...rest } = d;
  return rest;
}

module.exports = MemoryDriver;
