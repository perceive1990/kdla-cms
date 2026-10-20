'use strict';
// Tests of the JSON REST API at /api/v1 (in-memory database).
process.env.DB_DRIVER = 'memory';
process.env.MEMORY_DB_FILE = '';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-password-123';
process.env.LOGIN_MAX_FAILURES = '5';
process.env.API_RATE_LIMIT = '150';
process.env.API_CORS_ORIGINS = 'https://dashboard.example.org';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `kdla-api-test-${process.pid}`);

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { getDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runMigrations } = require('../src/migrations');
const { ensureBootstrapAdmin, createUser } = require('../scripts/lib');
const totp = require('../src/totp');
const { today } = require('../src/helpers');

let server; let origin;
const db = () => getDb();
const ADMIN_PW = 'Kitwe-office-2026';

async function api(method, path, { body, token, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${origin}/api/v1${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return {
    status: res.status, json, text, headers: res.headers,
  };
}

async function login(username, password, extra = {}) {
  const r = await api('POST', '/auth/login', { body: { username, password, ...extra } });
  assert.strictEqual(r.status, 201, `login ${username}: ${r.status} ${r.text}`);
  return r.json.token;
}

const ctx = {};

test.before(async () => {
  await db().init();
  await runMigrations(db());
  await ensureBootstrapAdmin(db());
  await createUser(db(), { username: 'officer1', password: 'officer-password-1', fullName: 'Mwila Banda' });
  await createUser(db(), { username: 'officer2', password: 'officer-password-2', fullName: 'Chanda Phiri' });
  await createUser(db(), { username: 'locky', password: 'locky-password-1', fullName: 'Lock Test' });
  await createUser(db(), { username: 'twostep', password: 'twostep-password-1', fullName: 'Two Step' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('public: index, OpenAPI description, docs page, and token required everywhere else', async () => {
  let r = await api('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.openapi, '/api/v1/openapi.json');
  r = await api('GET', '/openapi.json');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.openapi, '3.1.0');
  const ops = Object.values(r.json.paths).flatMap((p) => Object.values(p));
  assert.ok(ops.length >= 75, `only ${ops.length} operations described`);
  assert.ok(r.json.paths['/cases/{id}'].patch.parameters.some((p) => p.name === 'If-Match'));
  const docs = await fetch(`${origin}/api/docs`);
  assert.strictEqual(docs.status, 200);
  const html = await docs.text();
  assert.match(html, /Getting started/);
  assert.match(html, /\/cases\/\{id\}\/attachments/);
  assert.ok(!(docs.headers.get('set-cookie') || '').includes('kdla.sid'), 'docs page must not create a session');

  r = await api('GET', '/cases');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'unauthorized');
  assert.match(r.headers.get('www-authenticate'), /Bearer/);
  r = await api('GET', '/cases', { token: 'kdla_not-a-real-token' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'invalid_token');
  assert.ok(!(r.headers.get('set-cookie') || '').includes('kdla.sid'), 'the API must never start a web session');
});

test('sign-in rules: wrong password, lockout, missing fields, bad bodies', async () => {
  let r = await api('POST', '/auth/login', { body: { username: 'officer1' } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.password);
  r = await api('POST', '/auth/login', { body: { username: 'officer1', password: 'wrong-password' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'invalid_credentials');
  await db().replace('users', { ...(await db().get('users', (await db().find('users', { where: { username: 'officer1' } }))[0].id)), failedLogins: 0 });

  for (let i = 0; i < 5; i += 1) await api('POST', '/auth/login', { body: { username: 'locky', password: 'nope-nope-nope' } });
  r = await api('POST', '/auth/login', { body: { username: 'locky', password: 'locky-password-1' } });
  assert.strictEqual(r.status, 423);
  assert.strictEqual(r.json.error.code, 'account_locked');

  r = await api('POST', '/auth/login', { raw: '{"username": "officer1",', headers: { 'content-type': 'application/json' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'invalid_json');
  r = await api('POST', '/auth/login', { raw: 'username=officer1&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(r.status, 415);
  r = await api('POST', '/auth/login', { raw: '[1,2]', headers: { 'content-type': 'application/json' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'invalid_body');
});

test('temporary password must be changed first; other tokens end, this one keeps working', async () => {
  const first = await login('admin', 'admin-password-123');
  const second = await login('admin', 'admin-password-123');
  let r = await api('GET', '/cases', { token: first });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error.code, 'password_change_required');
  r = await api('GET', '/me', { token: first });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.requiredActions, ['change_password']);
  r = await api('POST', '/me/password', { token: first, body: { current: 'admin-password-123', password: 'short' } });
  assert.strictEqual(r.status, 422);
  r = await api('POST', '/me/password', { token: first, body: { current: 'admin-password-123', password: ADMIN_PW } });
  assert.strictEqual(r.status, 200, r.text);
  r = await api('GET', '/cases', { token: first });
  assert.strictEqual(r.status, 200);
  r = await api('GET', '/cases', { token: second });
  assert.strictEqual(r.status, 401, 'other tokens end when the password changes');
  ctx.admin = first;
  ctx.officer1 = await login('officer1', 'officer-password-1');
  ctx.officer2 = await login('officer2', 'officer-password-2');
});

test('two-step verification at API sign-in, and the "required" policy', async () => {
  const secret = totp.generateSecret();
  const [u] = await db().find('users', { where: { username: 'twostep' } });
  const codes = totp.generateRecoveryCodes();
  await db().replace('users', {
    ...u, totpEnabled: true, totpSecret: secret, recoveryCodes: codes.map(totp.hashRecoveryCode),
  });
  let r = await api('POST', '/auth/login', { body: { username: 'twostep', password: 'twostep-password-1' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'two_step_required');
  r = await api('POST', '/auth/login', { body: { username: 'twostep', password: 'twostep-password-1', code: '000000' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'invalid_code');
  assert.strictEqual((await db().get('users', u.id)).failedLogins, 1, 'a wrong code counts towards the lockout');
  const code = totp.hotp(totp.base32Decode(secret), totp.currentStep());
  r = await api('POST', '/auth/login', { body: { username: 'twostep', password: 'twostep-password-1', code } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual((await db().get('users', u.id)).failedLogins, 0);
  r = await api('POST', '/auth/login', { body: { username: 'twostep', password: 'twostep-password-1', code } });
  assert.strictEqual(r.status, 401, 'the same code cannot be used twice');
  r = await api('POST', '/auth/login', { body: { username: 'twostep', password: 'twostep-password-1', code: codes[0] } });
  assert.strictEqual(r.status, 201, 'a recovery code works');
  assert.strictEqual((await db().get('users', u.id)).recoveryCodes.length, codes.length - 1);

  // REQUIRE_2FA=admins: an administrator without two-step verification gets no token.
  const before = config.require2fa;
  config.require2fa = 'admins';
  try {
    r = await api('POST', '/auth/login', { body: { username: 'admin', password: ADMIN_PW } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error.code, 'two_step_setup_required');
    r = await api('GET', '/cases', { token: ctx.admin });
    assert.strictEqual(r.status, 403, 'existing tokens are held back too');
  } finally {
    config.require2fa = before;
  }
});

test('cases: create with defaults, versions, validation, conclude, confidentiality', async () => {
  const { officer1: o1, officer2: o2, admin } = ctx;
  // Client with duplicate check
  let r = await api('POST', '/people', {
    token: o1, body: { kind: 'client', firstName: 'Mary', lastName: 'Sampa', ageCategory: 'Woman', age: 34, nrc: '123456781', consentRecord: 'yes' },
  });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.nrc, '123456/78/1');
  assert.ok(!('nameKey' in r.json));
  const clientId = r.json.id;
  r = await api('POST', '/people', { token: o1, body: { kind: 'client', firstName: 'mary', lastName: 'SAMPA', ageCategory: 'Woman' } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'possible_matches');
  assert.strictEqual(r.json.error.matches.duplicates[0].id, clientId);
  r = await api('POST', '/people', { token: o1, body: { kind: 'client', firstName: 'mary', lastName: 'SAMPA', ageCategory: 'Woman', confirmMatches: true } });
  assert.strictEqual(r.status, 201);
  r = await api('POST', '/people', { token: o1, body: { kind: 'client', firstName: 'Girl', lastName: 'Child', ageCategory: 'Woman', age: 12 } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.ageCategory);
  r = await api('POST', '/people', { token: o1, body: { kind: 'robot', firstName: 'A', lastName: 'B' } });
  assert.strictEqual(r.status, 422);
  r = await api('POST', '/people', { token: o1, body: { kind: 'defendant', firstName: 'John', lastName: 'Mansa', ageCategory: 'Man', versusClientId: clientId } });
  assert.strictEqual(r.status, 201);
  const defendantId = r.json.id;
  ctx.clientId = clientId;

  // Validation
  r = await api('POST', '/cases', { token: o1, body: { heading: '' } });
  assert.strictEqual(r.status, 422);
  for (const f of ['heading', 'caseTypes', 'services', 'clientIds']) assert.ok(r.json.error.fields[f], `missing error for ${f}`);
  r = await api('POST', '/cases', { token: o1, raw: 'heading=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(r.status, 415);
  r = await api('POST', '/cases', {
    token: o1, body: { heading: 'Typo test', caseTypes: ['Land and Property', 'Land & Property'], services: ['Legal Advice'], clientIds: [clientId] },
  });
  assert.strictEqual(r.status, 422, 'unknown option values are reported, not dropped');
  assert.match(r.json.error.fields.caseTypes, /Land & Property/);
  r = await api('POST', '/people', { token: o1, body: { kind: 'client', firstName: 'Consent', lastName: 'Check', ageCategory: 'Man', consentRecord: 'maybe' } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.consentRecord);
  r = await api('POST', '/people', { token: o1, body: { kind: 'attendee', firstName: 'Consent', lastName: 'Upper', ageCategory: 'Man', consentRecord: 'Yes' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.consentRecord, 'yes');

  // Create: status, date, officer and office default as in the web form
  r = await api('POST', '/cases', {
    token: o1,
    body: {
      heading: 'Mary Sampa vs John Mansa', caseTypes: ['Land and Property'], services: ['Legal Advice', 'Mediation'], clientIds: [clientId], defendantIds: [defendantId],
    },
  });
  assert.strictEqual(r.status, 201, r.text);
  const c = r.json;
  assert.match(c.caseNumber, /^KDLA\/\d{4}\/\d{4}$/);
  assert.strictEqual(c.status, 'Open Active Case');
  assert.strictEqual(c.openedOn, today());
  assert.strictEqual(r.headers.get('location'), `/api/v1/cases/${c.id}`);
  assert.ok(c.etag && r.headers.get('etag') === c.etag);

  // Read, then change with and without If-Match
  r = await api('GET', `/cases/${c.id}`, { token: o2 });
  assert.strictEqual(r.status, 200);
  const etag = r.headers.get('etag');
  r = await api('PATCH', `/cases/${c.id}`, { token: o1, body: { complaint: 'Boundary dispute over a plot' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.heading, 'Mary Sampa vs John Mansa', 'fields left out keep their value');
  r = await api('PATCH', `/cases/${c.id}`, { token: o2, body: { actionTaken: 'Called both parties' }, headers: { 'if-match': etag } });
  assert.strictEqual(r.status, 412, 'a stale version is refused');
  assert.strictEqual(r.json.error.code, 'precondition_failed');
  assert.strictEqual(r.headers.get('etag'), null, 'errors carry no version tag');
  const fresh = await api('GET', `/cases/${c.id}`, { token: o2 });
  r = await api('PATCH', `/cases/${c.id}`, { token: o2, body: { actionTaken: 'Called both parties' }, headers: { 'if-match': fresh.json.etag } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.complaint, 'Boundary dispute over a plot');

  // Only the officer, creator or an administrator may change who can see the case
  r = await api('PATCH', `/cases/${c.id}`, { token: o2, body: { restricted: true } });
  assert.strictEqual(r.status, 403);

  // Concluding needs an outcome
  r = await api('PATCH', `/cases/${c.id}`, { token: o1, body: { status: 'Concluded Closed Case' } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.outcome);
  r = await api('PATCH', `/cases/${c.id}`, { token: o1, body: { status: 'Concluded Closed Case', outcome: 'Resolved through mediation' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.closedOn, today());
  assert.ok(r.json.history.some((x) => x.action === 'Case concluded'));
  r = await api('PATCH', `/cases/${c.id}`, { token: o1, body: { status: 'Open Active Case' } });
  assert.strictEqual(r.json.outcome, '', 'reopening clears the outcome');
  ctx.caseId = c.id;

  // Filters and paging
  r = await api('GET', '/cases?status=open&pageSize=1&sort=-openedOn', { token: o2 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.pageSize, 1);
  assert.strictEqual(r.json.data.length, 1);
  assert.ok(r.json.total >= 1);

  // Confidential case: hidden from officer2, visible to the officer, team and admins
  r = await api('POST', '/cases', {
    token: o1,
    body: {
      heading: 'GBV matter', caseTypes: ['Gender-Based Violence (GBV) related'], services: ['Legal Advice'], clientIds: [clientId], restricted: true,
    },
  });
  assert.strictEqual(r.status, 201);
  const secret = r.json;
  r = await api('GET', `/cases/${secret.id}`, { token: o2 });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error.code, 'confidential');
  r = await api('GET', '/cases?q=GBV', { token: o2 });
  assert.strictEqual(r.json.total, 0);
  r = await api('GET', '/cases?q=GBV', { token: admin });
  assert.strictEqual(r.json.total, 1);
  r = await api('GET', `/cases/${secret.id}/notes`, { token: o2 });
  assert.strictEqual(r.status, 403);
  r = await api('GET', `/people/${clientId}/links`, { token: o2 });
  const shown = r.json.cases.find((x) => x.id === secret.id);
  assert.strictEqual(shown.heading, 'Confidential case');
  r = await api('POST', '/tasks', { token: o2, body: { title: 'Try', dueDate: today(1), caseId: secret.id } });
  assert.strictEqual(r.status, 422, 'cannot attach a task to a confidential case you cannot open');
  r = await api('PATCH', `/cases/${secret.id}`, { token: o1, body: { teamIds: [(await db().find('users', { where: { username: 'officer2' } }))[0].id] } });
  assert.strictEqual(r.status, 200);
  r = await api('GET', `/cases/${secret.id}`, { token: o2 });
  assert.strictEqual(r.status, 200, 'team members can open it');
  ctx.secretId = secret.id;

  const audits = await db().find('audit', { where: { entity: 'cases', entityId: secret.id } });
  assert.ok(audits.some((a) => a.via === 'api' && /Blocked/.test(a.summary)), 'blocked views are audited as API actions');
});

test('case diary and files', async () => {
  const { officer1: o1, officer2: o2, caseId } = ctx;
  let r = await api('POST', `/cases/${caseId}/notes`, { token: o1, body: { type: 'Phone call', text: 'Called the client', minutes: 20 } });
  assert.strictEqual(r.status, 201);
  const noteId = r.json.id;
  r = await api('POST', `/cases/${caseId}/notes`, { token: o1, body: { type: 'Phone call', text: 'Future', date: today(5) } });
  assert.strictEqual(r.status, 422);
  r = await api('GET', `/cases/${caseId}/notes`, { token: o2 });
  assert.strictEqual(r.json.totalMinutes, 20);
  r = await api('DELETE', `/cases/${caseId}/notes/${noteId}`, { token: o2 });
  assert.strictEqual(r.status, 403, 'only the author or an administrator');
  r = await api('DELETE', `/cases/${caseId}/notes/${noteId}`, { token: o1 });
  assert.strictEqual(r.status, 204);

  // Upload
  const fd = new FormData();
  fd.append('files', new Blob(['Land agreement text'], { type: 'text/plain' }), 'agreement.txt');
  let res = await fetch(`${origin}/api/v1/cases/${caseId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${o1}` }, body: fd });
  assert.strictEqual(res.status, 201);
  const [file] = (await res.json()).data;
  assert.ok(!('key' in file), 'storage keys stay private');
  assert.strictEqual(file.downloadUrl, `/api/v1/cases/${caseId}/attachments/${file.id}`);
  res = await fetch(`${origin}${file.downloadUrl}`, { headers: { authorization: `Bearer ${o2}` } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'Land agreement text');
  assert.match(res.headers.get('content-disposition'), /attachment/);

  const bad = new FormData();
  bad.append('files', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'virus.exe');
  res = await fetch(`${origin}/api/v1/cases/${caseId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${o1}` }, body: bad });
  assert.strictEqual(res.status, 415);
  r = await api('POST', `/cases/${caseId}/attachments`, { token: o1, body: { files: [] } });
  assert.strictEqual(r.status, 415);
  const sneaky = new FormData();
  sneaky.append('files', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  res = await fetch(`${origin}/api/v1/cases/${ctx.secretId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${ctx.admin}` }, body: sneaky });
  assert.strictEqual(res.status, 201, 'administrators can attach to confidential cases');

  r = await api('GET', `/cases/${caseId}/attachments`, { token: o2 });
  assert.strictEqual(r.json.data.length, 1);
  r = await api('DELETE', `/cases/${caseId}/attachments/${file.id}`, { token: o1 });
  assert.strictEqual(r.status, 204);
  r = await api('GET', `/cases/${caseId}`, { token: o1 });
  assert.strictEqual(r.json.attachments.length, 0);
});

test('tasks and calendar files', async () => {
  const { officer1: o1, officer2: o2, caseId } = ctx;
  let r = await api('POST', '/tasks', {
    token: o1, body: { title: 'Mediation at the palace', type: 'Mediation session', dueDate: today(3), dueTime: '09:30', caseId },
  });
  assert.strictEqual(r.status, 201, r.text);
  const t = r.json;
  assert.strictEqual(t.case.id, caseId);
  r = await api('GET', '/tasks', { token: o1 });
  assert.ok(r.json.data.some((x) => x.id === t.id));
  r = await api('GET', '/tasks', { token: o2 });
  assert.ok(!r.json.data.some((x) => x.id === t.id), '"who" defaults to me');
  r = await api('GET', `/tasks?who=all&caseId=${caseId}`, { token: o2 });
  assert.ok(r.json.data.some((x) => x.id === t.id));
  r = await api('PATCH', `/tasks/${t.id}`, { token: o2, body: { title: 'Taken over' } });
  assert.strictEqual(r.status, 403);
  r = await api('PATCH', `/tasks/${t.id}`, { token: o1, body: { dueTime: '25:00' } });
  assert.strictEqual(r.status, 422);
  r = await api('POST', `/tasks/${t.id}/done`, { token: o1, body: {} });
  assert.strictEqual(r.json.done, true);
  r = await api('GET', `/tasks/${t.id}/calendar.ics`, { token: o1 });
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.text, /DTSTART:\d{8}T073000Z/, '09:30 in Lusaka is 07:30 UTC');
  r = await api('DELETE', `/tasks/${t.id}`, { token: o2 });
  assert.strictEqual(r.status, 403);
  r = await api('DELETE', `/tasks/${t.id}`, { token: o1 });
  assert.strictEqual(r.status, 204);
});

test('activity reports and attendance registers', async () => {
  const { officer1: o1 } = ctx;
  let r = await api('POST', '/reports', {
    token: o1,
    body: {
      activityType: 'Community Meeting', heading: 'Land rights meeting', district: 'Kitwe District', location: 'Fisenge hall',
      introduction: 'Intro', objectives: 'Objectives', implementation: 'Implementation', otherParticipants: 12,
    },
  });
  assert.strictEqual(r.status, 201, r.text);
  const rep = r.json;
  assert.strictEqual(rep.date, today());

  // Blank rows (with the default disability) are ignored; invalid rows stop the whole register.
  const attendeesBefore = (await db().find('people', { where: { kind: 'attendee' } })).length;
  r = await api('POST', `/reports/${rep.id}/attendees`, { token: o1, body: { rows: [{ disability: 'Not Disabled' }, { firstName: '' }] } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.rows);
  r = await api('POST', `/reports/${rep.id}/attendees`, {
    token: o1,
    body: {
      rows: [
        { firstName: 'Ruth', lastName: 'Chanda', ageCategory: 'Girl', age: 15, nrc: '111111/11/1' },
        { firstName: 'Bad', lastName: 'Row', ageCategory: 'Boy', age: 30 },
        { disability: 'Not Disabled' },
      ],
    },
  });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.rowErrors['1']);
  assert.strictEqual((await db().find('people', { where: { kind: 'attendee' } })).length, attendeesBefore, 'nothing saved');
  r = await api('POST', `/reports/${rep.id}/attendees`, {
    token: o1,
    body: {
      consentRecord: 'yes',
      rows: [
        { firstName: 'Ruth', lastName: 'Chanda', ageCategory: 'Girl', age: 15, nrc: '111111/11/1' },
        { firstName: 'Peter', lastName: 'Mulenga', ageCategory: 'Man', disability: 'Disabled' },
        { disability: 'Not Disabled' },
      ],
    },
  });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.added, 2);
  r = await api('POST', `/reports/${rep.id}/attendees`, { token: o1, body: { rows: [{ firstName: 'Ruth', lastName: 'Chanda', ageCategory: 'Girl', nrc: '111111/11/1' }] } });
  assert.strictEqual(r.json.added, 0);
  assert.strictEqual(r.json.linked, 0, 'already on this report');
  r = await api('GET', `/reports/${rep.id}/attendees`, { token: o1 });
  assert.strictEqual(r.json.data.length, 2);
  assert.strictEqual(r.json.withDisability, 1);
  assert.strictEqual(r.json.otherParticipants, 12);
  r = await api('DELETE', `/reports/${rep.id}`, { token: o1 });
  assert.strictEqual(r.status, 403, 'administrators only');
});

test('stakeholders, referrals and follow ups', async () => {
  const { officer1: o1, officer2: o2, admin, caseId } = ctx;
  let r = await api('POST', '/stakeholders', { token: o1, body: { name: 'Legal Aid Board', contactPerson: 'Mrs Zulu', phone: '0977000000', email: 'bad-email' } });
  assert.strictEqual(r.status, 422);
  r = await api('POST', '/stakeholders', { token: o1, body: { name: 'Legal Aid Board', contactPerson: 'Mrs Zulu', phone: '0977000000' } });
  assert.strictEqual(r.status, 201);
  const org = r.json;
  r = await api('POST', '/referrals', { token: o1, body: { caseId, organizationId: org.id, reason: 'Needs court representation' } });
  assert.strictEqual(r.status, 201, r.text);
  const ref = r.json;
  assert.ok(ref.warnings.length >= 1, 'warns that a client has not agreed to sharing');
  r = await api('GET', `/cases/${caseId}`, { token: o1 });
  assert.strictEqual(r.json.status, 'Open Referred');
  r = await api('POST', `/referrals/${ref.id}/follow-ups`, { token: o2, body: { description: 'Called the board', status: 'Concluded Closed Case' } });
  assert.strictEqual(r.status, 422, 'concluding happens on the case');
  r = await api('POST', `/referrals/${ref.id}/follow-ups`, { token: o2, body: { description: 'Called the board', followUp: 'Does not need follow up' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.followUps.length, 1);
  r = await api('GET', '/referrals?followUp=Does%20not%20need%20follow%20up', { token: o1 });
  assert.strictEqual(r.json.total, 1);

  // Referral on a confidential case: listed without details for people outside the case
  r = await api('POST', '/referrals', { token: o1, body: { caseId: ctx.secretId, organizationId: org.id, reason: 'Shelter needed' } });
  assert.strictEqual(r.status, 201);
  const hidden = r.json.id;
  const [o2user] = await db().find('users', { where: { username: 'officer2' } });
  const sc = await db().get('cases', ctx.secretId);
  await db().replace('cases', { ...sc, teamIds: [] });
  r = await api('GET', '/referrals', { token: o2 });
  const row = r.json.data.find((x) => x.id === hidden);
  assert.strictEqual(row.redacted, true);
  assert.ok(!('reason' in row));
  r = await api('GET', `/referrals/${hidden}`, { token: o2 });
  assert.strictEqual(r.status, 403);
  assert.ok(o2user);

  r = await api('DELETE', `/stakeholders/${org.id}`, { token: admin });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'in_use');
  r = await api('DELETE', `/stakeholders/${org.id}`, { token: o1 });
  assert.strictEqual(r.status, 403);
});

test('staff accounts, projects, statistics, search, rooms, audit and export', async () => {
  const { officer1: o1, officer2: o2, admin } = ctx;
  let r = await api('GET', '/users', { token: o1 });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.data.every((u) => !('email' in u) && !('passwordHash' in u)));
  r = await api('GET', '/users', { token: admin });
  assert.ok(r.json.data.every((u) => !('passwordHash' in u) && !('totpSecret' in u) && !('recoveryCodes' in u)));
  r = await api('POST', '/users', { token: o1, body: { username: 'newbie', fullName: 'New Person', password: 'Welcome-to-Kitwe-1' } });
  assert.strictEqual(r.status, 403);
  r = await api('POST', '/users', { token: admin, body: { username: 'newbie', fullName: 'New Person', password: 'Welcome-to-Kitwe-1' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.mustChangePassword, true);
  const newbie = r.json;

  // Disabling an account ends its tokens at once
  const officer2Id = (await db().find('users', { where: { username: 'officer2' } }))[0].id;
  r = await api('PATCH', `/users/${officer2Id}`, { token: admin, body: { active: false } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.signedOut, true);
  r = await api('GET', '/me', { token: o2 });
  assert.strictEqual(r.status, 401);
  r = await api('PATCH', `/users/${officer2Id}`, { token: admin, body: { active: true } });
  assert.strictEqual(r.json.active, true);
  ctx.officer2 = await login('officer2', 'officer-password-2');
  const adminId = (await db().find('users', { where: { username: 'admin' } }))[0].id;
  r = await api('PATCH', `/users/${adminId}`, { token: admin, body: { role: 'officer' } });
  assert.strictEqual(r.status, 422, 'administrators cannot remove their own access');
  r = await api('PATCH', `/users/${newbie.id}`, { token: admin, body: { role: 'superuser' } });
  assert.strictEqual(r.status, 422, 'an unknown role is refused, not turned into officer');
  assert.ok(r.json.error.fields.role);
  assert.ok(newbie.id);

  // Projects
  r = await api('POST', '/projects', { token: admin, body: { title: 'Land Rights 2026', startDate: '2026-01-01', endDate: '2026-12-31', budget: 50000 } });
  assert.strictEqual(r.status, 201, r.text);
  r = await api('GET', '/projects', { token: o1 });
  assert.strictEqual(r.json.data.length, 1);

  // Statistics, choices, search
  r = await api('GET', `/statistics?from=${today().slice(0, 4)}-01-01`, { token: o1 });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.totals.opened >= 2);
  r = await api('GET', '/statistics?from=2026-12-31&to=2026-01-01', { token: o1 });
  assert.strictEqual(r.status, 422);
  r = await api('GET', '/choices', { token: o1 });
  assert.ok(r.json.caseStatuses.includes('Open Active Case'));
  r = await api('GET', '/search?q=Sampa', { token: o1 });
  assert.ok(r.json.people.length >= 1);
  r = await api('GET', '/search?q=G', { token: o1 });
  assert.strictEqual(r.status, 422);
  r = await api('GET', '/conflicts?name=John%20Mansa', { token: o1 });
  assert.ok(r.json.data.some((x) => x.person.kind === 'defendant'));

  // Rooms
  r = await api('POST', '/rooms', { token: o1, body: { name: 'Advice on customary land' } });
  assert.strictEqual(r.status, 201);
  const room = r.json;
  r = await api('GET', `/rooms/${room.id}`, { token: ctx.officer2 });
  assert.strictEqual(r.status, 403);
  r = await api('POST', `/rooms/${room.id}/members`, { token: o1, body: { userId: officer2Id } });
  assert.strictEqual(r.json.added, true);
  r = await api('POST', `/rooms/${room.id}/messages`, { token: ctx.officer2, body: { content: 'Check the 1995 Lands Act' } });
  assert.strictEqual(r.status, 201);
  const sent = r.json;
  r = await api('POST', `/rooms/${room.id}/messages`, { token: ctx.officer2, body: { content: '   ' } });
  assert.strictEqual(r.status, 422);
  r = await api('GET', `/rooms/${room.id}/messages`, { token: o1 });
  assert.strictEqual(r.json.data[0].senderName, 'Chanda Phiri');
  r = await api('GET', `/rooms/${room.id}/messages?after=${encodeURIComponent(sent.createdAt)}`, { token: o1 });
  assert.strictEqual(r.json.data.length, 0);
  r = await api('DELETE', `/rooms/${room.id}`, { token: ctx.officer2 });
  assert.strictEqual(r.status, 403);

  // Audit and export
  r = await api('GET', '/audit', { token: o1 });
  assert.strictEqual(r.status, 403);
  r = await api('GET', '/audit?action=login', { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.data.some((e) => e.via === 'api' && /Signed in to the API/.test(e.summary)));
  r = await api('GET', '/export', { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(!('apiTokens' in r.json) && !('sessions' in r.json));
  assert.ok(r.json.users.every((u) => !u.passwordHash && !u.totpSecret));
});

test('personal access tokens: create with password, list, revoke; web page too', async () => {
  const { officer1: o1 } = ctx;
  let r = await api('POST', '/me/tokens', { token: o1, body: { label: 'Power BI', days: 30, password: 'wrong' } });
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.error.fields.password);
  r = await api('POST', '/me/tokens', { token: o1, body: { label: 'Power BI', days: 9999, password: 'officer-password-1' } });
  assert.strictEqual(r.status, 422);
  r = await api('POST', '/me/tokens', { token: o1, body: { label: 'Power BI', days: 30, password: 'officer-password-1' } });
  assert.strictEqual(r.status, 201);
  const pat = r.json.token;
  assert.match(pat, /^kdla_/);
  r = await api('GET', '/statistics', { token: pat });
  assert.strictEqual(r.status, 200);
  r = await api('GET', '/me/tokens', { token: o1 });
  const listed = r.json.data.find((t) => t.label === 'Power BI');
  assert.ok(listed && listed.kind === 'personal' && !('token' in listed));
  assert.ok(!JSON.stringify(r.json).includes(pat), 'the token is never shown again');
  const stored = await db().find('apiTokens', {});
  assert.ok(stored.every((d) => !JSON.stringify(d).includes(pat)), 'only a hash is stored');
  r = await api('DELETE', `/me/tokens/${listed.id}`, { token: o1 });
  assert.strictEqual(r.status, 204);
  r = await api('GET', '/statistics', { token: pat });
  assert.strictEqual(r.status, 401);

  // Web page: Account > API access
  const jar = {};
  const web = async (path, opts = {}) => {
    const res = await fetch(origin + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const [k, ...v] = pair.split('='); jar[k] = v.join('='); }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
  const form = async (path, fields, formPath) => {
    const page = await web(formPath);
    const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    return web(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token, ...fields }) });
  };
  r = await form('/login', { username: 'officer1', password: 'officer-password-1' }, '/login');
  assert.strictEqual(r.status, 302);
  r = await web('/account/api');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Create a personal token/);
  r = await form('/account/api/tokens', { label: 'Script', days: '90', password: 'officer-password-1' }, '/account/api');
  assert.strictEqual(r.status, 200);
  const shown = r.text.match(/id="new-token">(kdla_[^<]+)</);
  assert.ok(shown, 'new token shown once');
  r = await api('GET', '/me', { token: shown[1] });
  assert.strictEqual(r.status, 200);
  const page = await web('/account/api');
  assert.ok(!page.text.includes(shown[1]));
  const ref = page.text.match(/\/account\/api\/tokens\/([0-9a-f-]+)\/revoke/)[1];
  r = await form(`/account/api/tokens/${ref}/revoke`, {}, '/account/api');
  assert.strictEqual(r.status, 302);
  r = await api('GET', '/me', { token: shown[1] });
  assert.strictEqual(r.status, 401);
});

test('CORS only for configured sites, and the per-token rate limit', async () => {
  let res = await fetch(`${origin}/api/v1/cases`, { method: 'OPTIONS', headers: { origin: 'https://dashboard.example.org', 'access-control-request-method': 'GET' } });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://dashboard.example.org');
  assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  res = await fetch(`${origin}/api/v1/cases`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);

  const t = await login('officer1', 'officer-password-1');
  let last;
  for (let i = 0; i < 151; i += 1) last = await api('GET', '/choices', { token: t });
  assert.strictEqual(last.status, 429);
  assert.strictEqual(last.json.error.code, 'rate_limited');
  const other = await api('GET', '/choices', { token: ctx.officer1 });
  assert.strictEqual(other.status, 200, 'the limit is per token');
});

test('administrator deletes a person and a case through the API', async () => {
  const { admin, officer1: o1 } = ctx;
  let r = await api('POST', '/people', { token: o1, body: { kind: 'client', firstName: 'Temp', lastName: 'Person', ageCategory: 'Man' } });
  const pid = r.json.id;
  r = await api('DELETE', `/people/${pid}`, { token: o1 });
  assert.strictEqual(r.status, 403);
  r = await api('GET', `/people/${ctx.clientId}/personal-data`, { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.cases.length >= 1);
  r = await api('DELETE', `/people/${pid}`, { token: admin });
  assert.strictEqual(r.status, 204);
  r = await api('GET', `/people/${pid}`, { token: admin });
  assert.strictEqual(r.status, 404);
  r = await api('DELETE', `/cases/${ctx.caseId}`, { token: admin });
  assert.strictEqual(r.status, 204);
  assert.strictEqual((await db().find('referrals', { where: { caseId: ctx.caseId } })).length, 0);
  r = await api('GET', `/cases/${ctx.caseId}`, { token: admin });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, 'not_found');
});
