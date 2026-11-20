// Talking to the server from the live screens: JSON in, form fields out, with the page's security token.
// A session that has ended sends the person to the log-in page, as a page load would.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const token = () => {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
};

function toLogin() {
  const next = `${location.pathname}${location.search}`;
  location.href = `/login?expired=1&next=${encodeURIComponent(next)}`;
}

const MESSAGES = {
  403: 'This was refused. Reload the page and try again, or ask an administrator if it keeps happening.',
  404: 'That record no longer exists. Reload the page.',
  409: 'Someone else changed this record. Reload the page and try again.',
  503: 'The database is busy. Wait a few seconds and try again.',
};

async function read(res) {
  const toLoginPage = res.redirected && new URL(res.url).pathname === '/login';
  if (res.status === 401 || toLoginPage) {
    toLogin();
    throw new HttpError(401, 'Your session has ended. Log in again.');
  }
  const json = (res.headers.get('content-type') || '').includes('application/json');
  const body = json ? await res.json() : null;
  if (!res.ok) {
    const sent = body && (typeof body.error === 'string' ? body.error : body.error && body.error.message);
    throw new HttpError(res.status, sent || MESSAGES[res.status] || 'Something went wrong. Check your connection and try again.');
  }
  if (!body) throw new HttpError(res.status, 'The server sent an unexpected answer. Reload the page.');
  return body;
}

export async function getJson(url, { signal } = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal });
  return read(res);
}

export async function postForm(url, fields = {}) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': token() },
    body: new URLSearchParams(fields).toString(),
  });
  return read(res);
}
