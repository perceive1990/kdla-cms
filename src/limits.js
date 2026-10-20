'use strict';
// Rate limits shared by the web login page and the API, so both count against the same allowance.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { clientIp } = require('./audit');

// App Service puts the client port in X-Forwarded-For; without stripping it every request
// would get its own rate-limit bucket.
const ipKey = (req) => ipKeyGenerator(clientIp(req));

const isApi = (req) => req.originalUrl.startsWith('/api/');
const LOGIN_MESSAGE = 'Too many login attempts from this connection. Please wait 15 minutes and try again.';

/**
 * 20 failed sign-in attempts per 15 minutes per connection, across the web login, the two-step page and the API.
 * Successful sign-ins do not count, so a whole office behind one internet connection can log in each morning.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: (req, res) => {
    if (isApi(req)) return res.status(429).json({ error: { code: 'too_many_attempts', message: LOGIN_MESSAGE } });
    return res.status(429).render('login', {
      title: 'Log in', next: '', username: (req.body && req.body.username) || '', notice: null, error: LOGIN_MESSAGE,
    });
  },
});

module.exports = { ipKey, loginLimiter };
