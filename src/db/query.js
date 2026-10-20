'use strict';
// A tiny, safe query description shared by the Cosmos and in-memory drivers.
//
// find(container, {
//   where:   { status: 'Open', clientIds: { $contains: id }, id: { $in: [..] }, x: { $ne: null },
//              restricted: { $notTrue: true }, $or: [ { a: 1 }, { b: { $contains: 2 } } ] },
//   search:  { term: 'mwansa', fields: ['firstName', 'lastName'] },
//   orderBy: ['createdAt', 'DESC'],
//   fields:  ['id', 'status'],          // projection (optional)
//   offset: 0, limit: 25,
// })

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Cosmos DB NoSQL reserved words cannot be used with dot notation (c.value would fail).
const RESERVED = new Set([
  'and', 'array', 'as', 'asc', 'between', 'by', 'case', 'cast', 'convert', 'cross', 'desc', 'distinct', 'else',
  'end', 'escape', 'exists', 'false', 'for', 'from', 'group', 'having', 'in', 'inner', 'insert', 'into', 'is',
  'join', 'left', 'like', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order', 'outer', 'over', 'right',
  'select', 'set', 'then', 'top', 'true', 'udf', 'undefined', 'update', 'value', 'when', 'where', 'with',
]);

function assertField(name) {
  if (!FIELD.test(name)) throw new Error(`Invalid field name: ${name}`);
  if (RESERVED.has(name.toLowerCase())) throw new Error(`Field name is a Cosmos DB reserved word: ${name}`);
  return name;
}

function isOp(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Build a parameterised Cosmos SQL query from a query description. */
function toSql(q = {}, { count = false } = {}) {
  const params = [];
  const p = (value) => {
    const name = `@p${params.length}`;
    params.push({ name, value });
    return name;
  };

  const compile = (where) => {
    const clauses = [];
    for (const [field, cond] of Object.entries(where || {})) {
      if (cond === undefined) continue;
      if (field === '$or') {
        const parts = cond.map((sub) => compile(sub)).filter(Boolean);
        clauses.push(parts.length === cond.length && parts.length ? `(${parts.map((x) => `(${x})`).join(' OR ')})` : (cond.length ? 'true' : 'false'));
        continue;
      }
      if (field === '$and') {
        for (const sub of cond) {
          const part = compile(sub);
          if (part) clauses.push(`(${part})`);
        }
        continue;
      }
      const f = `c.${assertField(field)}`;
      if (isOp(cond)) {
        if ('$in' in cond) clauses.push(cond.$in.length ? `ARRAY_CONTAINS(${p(cond.$in)}, ${f})` : 'false');
        if ('$contains' in cond) clauses.push(`ARRAY_CONTAINS(${f}, ${p(cond.$contains)})`);
        if ('$ne' in cond) {
          clauses.push(cond.$ne === null ? `(IS_DEFINED(${f}) AND NOT IS_NULL(${f}))` : `${f} != ${p(cond.$ne)}`);
        }
        if ('$notTrue' in cond) clauses.push(`(NOT IS_DEFINED(${f}) OR IS_NULL(${f}) OR ${f} = false)`);
        if ('$gte' in cond) clauses.push(`${f} >= ${p(cond.$gte)}`);
        if ('$lte' in cond) clauses.push(`${f} <= ${p(cond.$lte)}`);
        if ('$lt' in cond) clauses.push(`${f} < ${p(cond.$lt)}`);
      } else if (cond === null) {
        clauses.push(`(NOT IS_DEFINED(${f}) OR IS_NULL(${f}))`);
      } else {
        clauses.push(`${f} = ${p(cond)}`);
      }
    }
    return clauses.join(' AND ');
  };

  const clauses = [];
  const main = compile(q.where);
  if (main) clauses.push(main);

  if (q.search && q.search.term && q.search.fields && q.search.fields.length) {
    const t = p(String(q.search.term));
    const ors = q.search.fields.map((fld) => `CONTAINS(ToString(c.${assertField(fld)}), ${t}, true)`);
    clauses.push(`(${ors.join(' OR ')})`);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  if (count) return { query: `SELECT VALUE COUNT(1) FROM c${where}`, parameters: params };

  const select = q.fields && q.fields.length
    ? q.fields.map((fld) => `c.${assertField(fld)}`).join(', ')
    : '*';
  let sql = `SELECT ${select} FROM c${where}`;
  if (q.orderBy) {
    const [fld, dir] = q.orderBy;
    sql += ` ORDER BY c.${assertField(fld)} ${String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
  }
  if (q.limit) sql += ` OFFSET ${Math.max(0, Number(q.offset) || 0)} LIMIT ${Math.max(1, Number(q.limit))}`;
  return { query: sql, parameters: params };
}

/** Evaluate the same query description against plain JS objects (in-memory driver). */
function matchWhere(doc, where) {
  for (const [field, cond] of Object.entries(where || {})) {
    if (cond === undefined) continue;
    if (field === '$or') {
      if (!cond.some((sub) => matchWhere(doc, sub))) return false;
      continue;
    }
    if (field === '$and') {
      if (!cond.every((sub) => matchWhere(doc, sub))) return false;
      continue;
    }
    assertField(field);
    const v = doc[field];
    if (isOp(cond)) {
      if ('$in' in cond && !cond.$in.includes(v)) return false;
      if ('$contains' in cond && !(Array.isArray(v) && v.includes(cond.$contains))) return false;
      if ('$ne' in cond) {
        if (cond.$ne === null ? v === undefined || v === null : (v === undefined || v === null || v === cond.$ne)) return false;
      }
      if ('$notTrue' in cond && v === true) return false;
      if ('$gte' in cond && !(v !== undefined && v !== null && v >= cond.$gte)) return false;
      if ('$lte' in cond && !(v !== undefined && v !== null && v <= cond.$lte)) return false;
      if ('$lt' in cond && !(v !== undefined && v !== null && v < cond.$lt)) return false;
    } else if (cond === null) {
      if (v !== undefined && v !== null) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function matches(doc, q = {}) {
  if (!matchWhere(doc, q.where)) return false;
  if (q.search && q.search.term && q.search.fields && q.search.fields.length) {
    const t = String(q.search.term).toLowerCase();
    const hit = q.search.fields.some((fld) => doc[fld] !== undefined && doc[fld] !== null
      && String(doc[fld]).toLowerCase().includes(t));
    if (!hit) return false;
  }
  return true;
}

module.exports = { toSql, matches, assertField };
