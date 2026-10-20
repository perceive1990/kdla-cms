'use strict';

/** An error with an HTTP status, used by services and turned into a page or a JSON reply by the caller. */
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} not found.`);
const forbidden = (message = 'You are not allowed to do this.') => new HttpError(403, 'forbidden', message);

module.exports = { HttpError, notFound, forbidden };
