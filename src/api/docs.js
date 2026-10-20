'use strict';
// Readable API reference at /api/docs, built from the OpenAPI description so the two never disagree.
const config = require('../config');
const { buildSpec, COMMON_ERRORS } = require('./openapi');

const METHOD_ORDER = ['get', 'post', 'patch', 'delete'];

function resolve(spec, schema) {
  if (schema && schema.$ref) return spec.components.schemas[schema.$ref.split('/').pop()];
  return schema;
}

function typeText(spec, s) {
  if (!s) return '';
  if (s.$ref) return s.$ref.split('/').pop();
  if (s.enum) return `one of: ${s.enum.map((v) => (v === '' ? '(empty)' : v)).join(' · ')}`;
  if (s.type === 'array') return `list of ${typeText(spec, s.items)}`;
  if (s.format === 'date') return 'date';
  if (s.format === 'date-time') return 'date and time';
  if (s.format === 'binary') return 'file';
  return Array.isArray(s.type) ? s.type.join(' or ') : s.type || 'object';
}

/** The fields of a request body, for the "Body" table. */
function fieldsOf(spec, schema) {
  const s = resolve(spec, schema);
  if (!s || !s.properties) return [];
  const required = new Set(s.required || []);
  return Object.entries(s.properties)
    .filter(([, p]) => !p.readOnly)
    .map(([name, p]) => ({
      name, type: typeText(spec, p), required: required.has(name), description: p.description || '',
    }));
}

/** Operations grouped by tag, in the order the tags are declared. */
function docsModel(spec) {
  const groups = spec.tags.map((t) => ({ ...t, ops: [] }));
  const byTag = Object.fromEntries(groups.map((g) => [g.name, g]));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHOD_ORDER) {
      const o = item[method];
      if (!o) continue;
      const content = o.requestBody && o.requestBody.content;
      let body = null;
      if (content && content['multipart/form-data']) body = { multipart: true };
      else if (content) body = { fields: fieldsOf(spec, content['application/json'].schema) };
      byTag[o.tags[0]].ops.push({
        id: o.operationId,
        method: method.toUpperCase(),
        path,
        summary: o.summary,
        description: o.description || '',
        admin: Boolean(o['x-admin-only']),
        public: Array.isArray(o.security) && o.security.length === 0,
        params: (o.parameters || []).map((p) => ({
          name: p.name, in: p.in, required: Boolean(p.required), description: p.description || '',
          type: p.name === 'sort' ? 'string' : typeText(spec, p.schema), // the description already lists the choices
        })),
        body,
        // Errors possible on every request are explained once on the page, not repeated here.
        responses: Object.entries(o.responses)
          .filter(([code, r]) => COMMON_ERRORS[code] !== r.description)
          .map(([code, r]) => ({ code, description: r.description })),
      });
    }
  }
  return groups.filter((g) => g.ops.length);
}

let cached = null;

function docsPage(req, res) {
  if (!cached) {
    const spec = buildSpec();
    cached = { spec, groups: docsModel(spec) };
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  res.render('api-docs', {
    title: 'API',
    spec: cached.spec,
    groups: cached.groups,
    baseUrl: `${origin}/api/v1`,
    tokenHours: config.api.tokenHours,
    rateLimit: config.api.rateLimitPerMinute,
    maxDays: config.api.personalTokenMaxDays,
    corsOrigins: config.api.corsOrigins,
  });
}

module.exports = { docsPage, docsModel };
