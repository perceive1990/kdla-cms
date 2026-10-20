'use strict';
// JSON REST API, version 1, mounted at /api/v1.
// Sign in with POST /api/v1/auth/login (or create a personal token under Account > API access) and
// send "Authorization: Bearer <token>". The API follows exactly the same rules as the web pages
// (confidential cases, administrator-only actions, audit trail), because both use src/services.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const config = require('../config');
const { ipKey } = require('../limits');
const { HttpError } = require('../services/errors');
const { authenticate, open, secured } = require('./auth');
const { buildSpec } = require('./openapi');

const ERROR_EXTRAS = ['fields', 'matches', 'rowErrors'];

/** Browsers may call the API only from the sites listed in API_CORS_ORIGINS. */
function cors(req, res, next) {
  const origin = req.get('origin');
  const allowed = origin && (config.api.corsOrigins.includes(origin) || config.api.corsOrigins.includes('*'));
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    res.set('Access-Control-Expose-Headers', 'ETag, Location, Retry-After, RateLimit, RateLimit-Policy, Content-Disposition');
  }
  if (req.method === 'OPTIONS') {
    if (allowed) {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match');
      res.set('Access-Control-Max-Age', '600');
    }
    return res.status(204).end();
  }
  return next();
}

/** Requests with a body must send JSON (or multipart/form-data for file uploads). */
function bodyRules(req, res, next) {
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const hasBody = Number(req.get('content-length') || 0) > 0 || Boolean(req.get('transfer-encoding'));
    if (hasBody && !req.is('application/json') && !req.is('multipart/form-data')) {
      throw new HttpError(415, 'unsupported_media_type', 'Send the request body as JSON with "Content-Type: application/json".');
    }
  }
  if (req.body === undefined) req.body = {};
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  next();
}

const tooMany = (req, res) => res.status(429).json({
  error: { code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' },
});

function errorReply(err, req, res, next) {
  if (res.headersSent) return next(err);
  const send = (status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
  if (err instanceof HttpError) {
    const extra = {};
    for (const k of ERROR_EXTRAS) if (err[k] !== undefined) extra[k] = err[k];
    return send(err.status, err.code, err.message, extra);
  }
  if (err && err.type === 'entity.parse.failed') return send(400, 'invalid_json', 'The request body is not valid JSON.');
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return send(413, 'too_large', 'The request is too large.');
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return send(413, 'file_too_large', `Each file must be under ${config.storage.maxFileMb} MB.`);
    return send(400, 'invalid_upload', `Upload problem: ${err.message}. Send up to 5 files in a field called "files".`);
  }
  if (err && err.code === 412) {
    return send(412, 'precondition_failed', 'This record was changed by someone else after you read it. Fetch it again, then reapply your changes.');
  }
  if (err && err.code === 429) {
    res.set('Retry-After', '5');
    return send(503, 'busy', 'The database is busy. Wait a few seconds and try again.');
  }
  console.error(err);
  return send(500, 'server_error', config.isProd ? 'Something went wrong. Please try again.' : String(err && err.message));
}

function createApiRouter() {
  const router = express.Router();
  const spec = buildSpec();

  router.use(cors);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '1mb' }));
  router.use(bodyRules);

  router.get('/', (req, res) => res.json({
    name: `${config.appName} API`, version: spec.info.version, docs: '/api/docs', openapi: '/api/v1/openapi.json',
    signIn: 'POST /api/v1/auth/login',
  }));
  router.get('/openapi.json', (req, res) => res.json(spec));

  // Generous limit per connection before sign-in, then a limit per token.
  router.use(rateLimit({
    windowMs: 60 * 1000, limit: Math.max(600, config.api.rateLimitPerMinute * 4), keyGenerator: ipKey,
    standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany,
  }));
  router.use(open);
  router.use(authenticate);
  router.use(rateLimit({
    windowMs: 60 * 1000, limit: config.api.rateLimitPerMinute, keyGenerator: (req) => `token:${req.apiToken.id}`,
    standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany,
  }));
  router.use(secured);
  router.use(require('./routes/cases'));
  router.use(require('./routes/people'));
  router.use(require('./routes/tasks'));
  router.use(require('./routes/reports'));
  router.use(require('./routes/referrals'));
  router.use(require('./routes/directory'));
  router.use(require('./routes/misc'));

  router.use((req) => {
    throw new HttpError(404, 'not_found', `No API endpoint ${req.method} ${req.baseUrl}${req.path}. See /api/docs.`);
  });
  router.use(errorReply);
  return router;
}

module.exports = { createApiRouter };
