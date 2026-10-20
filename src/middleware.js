'use strict';
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

/**
 * Minimal flash messages stored in the session.
 * Reading never writes to the session, so anonymous visitors and bots do not create session records.
 */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  const pending = req.session && req.session.flash;
  if (pending && pending.length) {
    res.locals.flashes = pending;
    req.session.flash = [];
  } else {
    res.locals.flashes = [];
  }
  next();
}

/**
 * Synchroniser-token CSRF protection for every non-GET request.
 * A token is only issued to logged-in users and on the login page.
 */
function csrf(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!req.session.csrfToken && safe && (req.user || req.path === '/login' || req.path === '/login/verify')) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken || '';
  if (safe) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(req.session.csrfToken || ''));
  if (b.length && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403);
  return res.render('error', { title: 'Form expired', message: 'This form has expired or is invalid. Go back, reload the page and try again.' });
}

const ALLOWED_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain|text\/csv|application\/(msword|vnd\.openxmlformats-officedocument\..+|vnd\.ms-excel|vnd\.oasis\.opendocument\..+|zip|x-zip-compressed))$/;

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.storage.maxFileMb * 1024 * 1024, files: 5, fields: 300, fieldSize: 200 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.test(file.mimetype)) return cb(null, true);
    return cb(Object.assign(new Error(`File type not allowed: ${file.originalname}`), { status: 400 }));
  },
}).array('attachments', 5);

/**
 * Parse multipart forms (file uploads) before the CSRF check so the token in the form body can be read.
 * Only for logged-in users, so anonymous requests cannot make the server buffer large uploads.
 */
function multipart(req, res, next) {
  if (!req.is('multipart/form-data') || !req.user) return next();
  return uploader(req, res, (err) => {
    if (!err) return next();
    req.flash('danger', err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be under ${config.storage.maxFileMb} MB.`
      : err.message || 'Upload failed.');
    return res.redirect(safeBack(req));
  });
}

/** Same-site referer or a fallback, never an external URL. */
function safeBack(req, fallback = '/') {
  const ref = req.get('referer');
  if (!ref) return fallback;
  try {
    const u = new URL(ref);
    if (u.host !== req.get('host')) return fallback;
    return u.pathname + u.search;
  } catch (e) {
    return fallback;
  }
}

module.exports = {
  flash, csrf, multipart, safeBack, ALLOWED_TYPES,
};
