'use strict';
const { CosmosClient } = require('@azure/cosmos');
const containersDef = require('./containers');
const { toSql } = require('./query');

/**
 * Azure Cosmos DB for NoSQL driver.
 * One database with shared throughput (free tier: 1000 RU/s, 25 GB), one container per entity.
 */
class CosmosDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = cfg.connectionString
      ? new CosmosClient(cfg.connectionString)
      : new CosmosClient({ endpoint: cfg.endpoint, key: cfg.key });
    this.c = {};
  }

  async init() {
    const dbOpts = { id: this.cfg.database };
    if (this.cfg.throughput > 0) dbOpts.throughput = this.cfg.throughput;
    const { database } = await this.client.databases.createIfNotExists(dbOpts);
    this.database = database;
    for (const [name, def] of Object.entries(containersDef)) {
      const opts = { id: name, partitionKey: { paths: [`/${def.pk}`] } };
      if (def.ttl) opts.defaultTtl = -1; // enables per-item "ttl" (used for sessions)
      const { container } = await database.containers.createIfNotExists(opts);
      this.c[name] = container;
    }
  }

  _pkOf(name, doc) {
    return doc[containersDef[name].pk];
  }

  async create(name, doc) {
    const { resource } = await this.c[name].items.create(cleanForWrite(doc));
    return strip(resource, true);
  }

  async upsert(name, doc) {
    const { resource } = await this.c[name].items.upsert(cleanForWrite(doc));
    return strip(resource, true);
  }

  async get(name, id, pk) {
    if (!id) return null;
    try {
      const { resource } = await this.c[name].item(String(id), pk === undefined ? String(id) : pk).read();
      return resource ? strip(resource, true) : null;
    } catch (err) {
      if (err.code === 404) return null;
      throw err;
    }
  }

  /** Replace a document. Pass { ifMatch: etag } for optimistic concurrency (412 on conflict). */
  async replace(name, doc, { ifMatch } = {}) {
    const opts = ifMatch ? { accessCondition: { type: 'IfMatch', condition: ifMatch } } : {};
    const { resource } = await this.c[name].item(doc.id, this._pkOf(name, doc)).replace(cleanForWrite(doc), opts);
    return strip(resource, true);
  }

  async remove(name, id, pk) {
    try {
      await this.c[name].item(String(id), pk === undefined ? String(id) : pk).delete();
      return true;
    } catch (err) {
      if (err.code === 404) return false;
      throw err;
    }
  }

  _queryOpts(name, q) {
    const pkField = containersDef[name].pk;
    const v = q && q.where && q.where[pkField];
    return v !== undefined && v !== null && typeof v !== 'object' ? { partitionKey: v } : {};
  }

  async find(name, q = {}) {
    const { resources } = await this.c[name].items.query(toSql(q), this._queryOpts(name, q)).fetchAll();
    return resources.map((r) => strip(r));
  }

  async count(name, q = {}) {
    const { resources } = await this.c[name].items.query(toSql(q, { count: true }), this._queryOpts(name, q)).fetchAll();
    return resources.reduce((a, b) => a + b, 0);
  }

  /** Atomic counter using optimistic concurrency, e.g. for case numbers. */
  async nextSequence(key) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.get('meta', key);
      try {
        if (!current) {
          await this.create('meta', { id: key, value: 1 });
          return 1;
        }
        const next = { ...current, value: (current.value || 0) + 1 };
        await this.replace('meta', next, { ifMatch: current._etag });
        return next.value;
      } catch (err) {
        if (err.code === 409 || err.code === 412) continue; // someone else won the race; retry
        throw err;
      }
    }
    throw new Error('Could not allocate sequence number, please retry');
  }
}

// Remove Cosmos system properties; keep _etag when asked (single reads and writes, for concurrency checks).
function strip(doc, keepEtag = false) {
  if (!doc) return doc;
  const { _rid, _self, _attachments, _ts, _etag, ...rest } = doc;
  if (keepEtag && _etag) rest._etag = _etag;
  return rest;
}

function cleanForWrite(doc) {
  const { _etag, ...rest } = doc;
  return rest;
}

module.exports = CosmosDriver;
