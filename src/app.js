'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');

const config = require('./config');
const choices = require('./choices');
const helpers = require('./helpers');
const form = require('./form');
const { getDb } = require('./db');
const DbSessionStore = require('./session-store');
const { flash, csrf, multipart, safeBack } = require('./middleware');
const { requireLogin, needs2faSetup } = require('./auth');
const { themeOf } = require('./theme');
const { HttpError } = require('./services/errors');
const { createApiRouter } = require('./api');
const { docsPage } = require('./api/docs');

const ROOT = path.join(__dirname, '..');

/** Short hash of our own CSS/JS so browsers fetch new versions after each deployment. */
function assetVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ['public/css/app.css', 'public/js/app.js', 'public/js/theme.js']) {
    try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch (e) { /* optional file */ }
  }
  return h.digest('hex').slice(0, 10);
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json');
}

function createApp() {
  const db = getDb();
  const app = express();
  const version = assetVersion();

  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', 1); // App Service terminates TLS in front of the app
  app.disable('x-powered-by');
  // No automatic ETags: pages are private and change constantly, and API records carry their own
  // database version tag (an automatic tag on a list or an error would be useless with If-Match).
  app.set('etag', false);

  // Base values every page needs, set first so even error pages can render.
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      config, choices, h: helpers, f: form, path: req.path, query: req.query, title: '',
      user: null, flashes: [], csrfToken: '', assetVersion: version, theme: themeOf(null),
    });
    req.db = db;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // private system: keep out of search engines
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(compression());

  const staticOpts = { maxAge: config.isProd ? '30d' : 0, immutable: config.isProd };
  app.use('/static', express.static(path.join(ROOT, 'public'), staticOpts));
  app.use('/vendor/bootstrap', express.static(path.join(ROOT, 'node_modules', 'bootstrap', 'dist'), staticOpts));
  app.use('/vendor/bootstrap-icons', express.static(path.join(ROOT, 'node_modules', 'bootstrap-icons', 'font'), staticOpts));

  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(ROOT, 'public', 'images', 'icon-192.png'), { maxAge: '7d' }));
  app.get('/healthz', async (req, res) => {
    if (!req.query.db) return res.json({ ok: true });
    try {
      await db.count('meta', {});
      return res.json({ ok: true, db: 'ok' });
    } catch (e) {
      return res.status(503).json({ ok: false, db: 'unavailable' });
    }
  });

  // JSON REST API. Mounted before the session and form parsers: it uses bearer tokens, never cookies,
  // so it needs no CSRF token and creates no web sessions.
  if (config.api.enabled) app.use('/api/v1', createApiRouter());

  app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 2000 }));
  app.use(express.json({ limit: '200kb' }));

  app.use(session({
    name: 'kdla.sid',
    secret: config.sessionSecret,
    store: new DbSessionStore(db, { ttlSeconds: config.sessionIdleMinutes * 60 }),
    resave: false,
    saveUninitialized: false,
    rolling: true, // every request extends the idle timeout
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: config.sessionIdleMinutes * 60 * 1000,
    },
  }));

  // Load the logged-in user. Sessions end when idle, when older than SESSION_MAX_HOURS,
  // when the account is disabled, or when the password or two-step settings change.
  app.use(async (req, res, next) => {
    req.user = null;
    const s = req.session;
    if (s && s.userId) {
      const tooOld = config.sessionMaxHours > 0 && s.authAt && Date.now() - s.authAt > config.sessionMaxHours * 3600 * 1000;
      const u = tooOld ? null : await db.get('users', s.userId);
      if (u && u.active !== false && (s.epoch || 0) === (u.sessionEpoch || 0)) {
        req.user = u;
      } else {
        return s.destroy(() => {
          res.clearCookie('kdla.sid');
          if (wantsJson(req)) return res.status(401).json({ error: 'Session ended' });
          return res.redirect('/login?expired=1');
        });
      }
    }
    res.locals.user = req.user;
    res.locals.theme = themeOf(req.user);
    return next();
  });

  app.use(flash);
  app.use(multipart);
  app.use(csrf);

  // Staff with a temporary password, or who must use two-step verification, finish that first.
  app.use((req, res, next) => {
    const u = req.user;
    if (!u) return next();
    const free = req.path.startsWith('/account/') || req.path === '/logout';
    if (free) return next();
    let target = null;
    if (u.mustChangePassword) target = ['/account/password', 'Please choose a new password to continue.'];
    else if (needs2faSetup(u)) target = ['/account/security', 'KDLA requires two-step verification for your account. Please set it up to continue.'];
    if (!target) return next();
    if (req.method !== 'GET') return res.status(403).render('error', { title: 'Action needed', message: target[1] });
    req.flash('warning', target[1]);
    return res.redirect(target[0]);
  });

  // Overdue task count for the navigation badge (one small count query per page).
  app.use(async (req, res, next) => {
    if (req.user && req.method === 'GET' && !wantsJson(req) && !req.path.startsWith('/files/')) {
      try {
        res.locals.navCounts = {
          overdue: await db.count('tasks', { where: { assigneeId: req.user.id, done: false, dueDate: { $lt: helpers.today() } } }),
        };
      } catch (e) { /* badge is optional */ }
    }
    next();
  });

  if (config.api.enabled) {
    app.get('/api', (req, res) => res.redirect('/api/docs'));
    app.get('/api/docs', docsPage); // public reference; no data, so no login needed
  }

  app.use(require('./routes/auth'));
  app.use('/files', requireLogin, require('./routes/files'));
  app.use('/', requireLogin, require('./routes/dashboard'));
  app.use('/cases', requireLogin, require('./routes/cases'));
  app.use('/tasks', requireLogin, require('./routes/tasks'));
  app.use('/people', requireLogin, require('./routes/people'));
  app.use('/reports', requireLogin, require('./routes/reports'));
  app.use('/stakeholders', requireLogin, require('./routes/stakeholders'));
  app.use('/referrals', requireLogin, require('./routes/referrals'));
  app.use('/rooms', requireLogin, require('./routes/rooms'));
  app.use('/statistics', requireLogin, require('./routes/stats'));
  app.use('/account', requireLogin, require('./routes/account'));
  app.use('/admin', requireLogin, require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page or record does not exist.' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Rule errors from the service layer (not found, confidential, not allowed, in use).
    if (err instanceof HttpError) {
      if (wantsJson(req)) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      const titles = {
        400: 'Check your entry', 404: 'Not found', 409: 'Cannot do that', 422: 'Check your entry',
        403: err.code === 'confidential' ? 'Confidential case' : 'Not allowed',
      };
      return res.status(err.status).render('error', {
        title: titles[err.status] || 'Something went wrong',
        message: err.status === 404 ? 'That page or record does not exist.' : err.message,
      });
    }
    if (err && err.code === 412) {
      req.flash('warning', 'Someone else changed this record while you were editing. Please review the latest version and make your changes again.');
      return res.redirect(safeBack(req));
    }
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      res.status(413);
      return res.render('error', { title: 'Too large', message: 'The form was too large to save. Shorten the text or attach fewer files.' });
    }
    if (err && err.code === 429) {
      res.status(503);
      return res.render('error', { title: 'Busy', message: 'The database is busy. Please wait a few seconds and try again.' });
    }
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500);
    if (wantsJson(req)) return res.json({ error: 'Something went wrong' });
    return res.render('error', {
      title: 'Something went wrong',
      message: config.isProd ? 'An unexpected error occurred. Please try again.' : String(err && err.stack),
    });
  });

  return app;
}

module.exports = { createApp };
