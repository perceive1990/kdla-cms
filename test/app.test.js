'use strict';
// End-to-end tests of every main workflow using the in-memory database.
// Run with: npm test
process.env.DB_DRIVER = 'memory';
process.env.MEMORY_DB_FILE = '';
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-password-123';
process.env.LOGIN_MAX_FAILURES = '5';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `kdla-test-${process.pid}`);

const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runMigrations } = require('../src/migrations');
const { ensureBootstrapAdmin, createUser } = require('../scripts/lib');
const totp = require('../src/totp');

let server; let base;
const ADMIN_PW = 'Kitwe-office-2026';

class Client {
  constructor() { this.jar = {}; }

  get cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }

  async req(path, opts = {}) {
    const res = await fetch(base + path, {
      redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie: this.cookie },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      if (/expires=Thu, 01 Jan 1970/i.test(c)) delete this.jar[k];
      else this.jar[k] = v.join('=');
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }

  async csrf(path) {
    const r = await this.req(path);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(m, `no csrf token on ${path} (status ${r.status} ${r.location || ''})`);
    return m[1];
  }

  async post(path, fields, formPath) {
    const token = await this.csrf(formPath || path);
    const body = new URLSearchParams();
    body.append('_csrf', token);
    for (const [k, v] of Object.entries(fields)) {
      for (const item of (Array.isArray(v) ? v : [v])) body.append(k, item);
    }
    return this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  async postMultipart(path, fields, files, formPath) {
    const token = await this.csrf(formPath);
    const fd = new FormData();
    fd.append('_csrf', token);
    for (const [k, v] of Object.entries(fields)) for (const item of (Array.isArray(v) ? v : [v])) fd.append(k, item);
    for (const f of files) fd.append('attachments', new Blob([f.content], { type: f.type }), f.name);
    return this.req(path, { method: 'POST', body: fd });
  }

  async login(username, password, expect = 302) {
    const r = await this.post('/login', { username, password }, '/login');
    assert.strictEqual(r.status, expect, `login ${username}: ${r.status} ${r.text.slice(0, 200)}`);
    return r;
  }
}

const idFrom = (loc) => loc.split('#')[0].split('?')[0].split('/').pop();
const db = () => getDb();
const userId = async (username) => (await db().find('users', { where: { username } }))[0].id;
const { today } = require('../src/helpers');

const ctx = {};

test.before(async () => {
  await db().init();
  await runMigrations(db());
  await ensureBootstrapAdmin(db());
  await createUser(db(), { username: 'officer1', password: 'officer-password-1', fullName: 'Mwila Banda' });
  await createUser(db(), { username: 'officer2', password: 'officer-password-2', fullName: 'Chanda Phiri' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('public endpoints and anonymous visitors', async () => {
  const c = new Client();
  let r = await c.req('/healthz');
  assert.strictEqual(r.status, 200);
  r = await c.req('/robots.txt');
  assert.match(r.text, /Disallow: \//);
  r = await c.req('/favicon.ico');
  assert.strictEqual(r.status, 200);
  r = await c.req('/cases');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /^\/login\?next=/);
  assert.ok(!c.jar['kdla.sid'], 'redirecting an anonymous visitor must not create a session');
  r = await c.req('/login?next=%2Fcases');
  assert.match(r.text, /Please log in to continue/);
  assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('first administrator must change the bootstrap password', async () => {
  const c = new Client();
  await c.login('admin', 'admin-password-123');
  let r = await c.req('/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/account/password');
  r = await c.post('/account/password', { current: 'admin-password-123', password: 'short', confirm: 'short' }, '/account/password');
  assert.strictEqual(r.status, 400);
  r = await c.post('/account/password', { current: 'admin-password-123', password: 'admin-password-456', confirm: 'admin-password-456' }, '/account/password');
  assert.strictEqual(r.status, 400, 'password containing the username is refused');
  r = await c.post('/account/password', { current: 'admin-password-123', password: ADMIN_PW, confirm: ADMIN_PW }, '/account/password');
  assert.strictEqual(r.status, 302);
  r = await c.req('/');
  assert.strictEqual(r.status, 200);
});

test('rejects form posts without a CSRF token and anonymous uploads', async () => {
  const c = new Client();
  await c.login('admin', ADMIN_PW);
  let r = await c.req('/stakeholders', { method: 'POST', body: 'name=X', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(r.status, 403);
  const anon = new Client();
  const fd = new FormData();
  fd.append('attachments', new Blob(['x'.repeat(1000)], { type: 'application/pdf' }), 'a.pdf');
  r = await anon.req('/cases', { method: 'POST', body: fd });
  assert.ok([302, 403].includes(r.status), `anonymous upload status ${r.status}`);
});

test('wrong passwords lock the account; admin can unlock', async () => {
  await createUser(db(), { username: 'locktest', password: 'locktest-password-1', fullName: 'Lock Test' });
  const c = new Client();
  for (let i = 0; i < 5; i += 1) await c.login('locktest', 'wrong-password', 401);
  await c.login('locktest', 'locktest-password-1', 423);
  const a = new Client();
  await a.login('admin', ADMIN_PW);
  const id = await userId('locktest');
  const r = await a.post(`/admin/users/${id}`, { fullName: 'Lock Test', role: 'officer', active: 'on', unlock: 'on' }, `/admin/users/${id}/edit`);
  assert.strictEqual(r.status, 302);
  await c.login('locktest', 'locktest-password-1', 302);
});

test('full workflow: client, conflict checks, case, diary, tasks, referral, report, chat, statistics', async () => {
  const a = new Client();
  await a.login('admin', ADMIN_PW);
  ctx.admin = a;

  let r = await a.post('/admin/projects', {
    title: 'Access to Justice', donor: 'DIHR', startDate: '2026-01-01', endDate: '2027-12-31', budget: '600000', currency: 'DKK',
  }, '/admin/projects/new');
  assert.strictEqual(r.status, 302);
  const projectId = (await db().find('projects', {}))[0].id;

  // Validation
  r = await a.post('/people/clients', { firstName: '', lastName: 'X', ageCategory: '' }, '/people/clients/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Enter a first name/);
  r = await a.post('/people/clients', { firstName: 'Old', lastName: 'Girl', age: '40', ageCategory: 'Girl' }, '/people/clients/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Girl is for people under 18/);

  r = await a.post('/people/clients', {
    firstName: 'Mary', lastName: 'Sampa', nrc: '123456781', age: '42', ageCategory: 'Woman', civilStatus: 'Widow or Widower',
    disability: 'Not Disabled', contact: '0977000000', projectId, caseNumber: 'FIS-001', referralSource: 'Community Meeting',
    consentRecord: 'yes', consentShare: 'yes',
  }, '/people/clients/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const clientId = idFrom(r.location);
  const client = await db().get('people', clientId);
  assert.strictEqual(client.nrc, '123456/78/1');
  assert.strictEqual(client.nameKey, 'mary sampa');
  assert.strictEqual(client.consentDate, today());

  r = await a.post('/people/clients', { firstName: 'Dup', lastName: 'Licate', nrc: '123456/78/1', ageCategory: 'Man' }, '/people/clients/new');
  assert.strictEqual(r.status, 400, 'duplicate NRC rejected');

  // Duplicate name needs confirmation
  r = await a.post('/people/clients', { firstName: 'MARY', lastName: ' sampa ', ageCategory: 'Woman' }, '/people/clients/new');
  assert.strictEqual(r.status, 409);
  assert.match(r.text, /may already be registered/);

  r = await a.post('/people/defendants', { firstName: 'John', lastName: 'Mansa', ageCategory: 'Man', versusClientId: clientId }, '/people/defendants/new');
  assert.strictEqual(r.status, 302);
  const defendantId = idFrom(r.location);

  // Registering the opponent as a client triggers the conflict check
  r = await a.post('/people/clients', { firstName: 'John', lastName: 'Mansa', ageCategory: 'Man' }, '/people/clients/new');
  assert.strictEqual(r.status, 409);
  assert.match(r.text, /Possible conflict of interest/);
  r = await a.req('/conflicts?name=john+mansa');
  assert.match(r.text, /Other party \(opponent\)/);

  const officerId = await userId('officer1');
  r = await a.postMultipart('/cases', {
    heading: 'Mary Sampa vs John Mansa', openedOn: '2026-03-02', caseTypes: ['Land and Property'], services: ['Legal Advice', 'Mediation'],
    complaint: 'Land grabbed after husband died.', status: 'Open Active Case', officerId,
    clientIds: [clientId], defendantIds: [defendantId], office: 'Fisenge Office',
  }, [{ name: 'statement.pdf', type: 'application/pdf', content: '%PDF-1.4 test' }], '/cases/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const caseId = idFrom(r.location);
  ctx.caseId = caseId;
  const kase = await db().get('cases', caseId);
  assert.strictEqual(kase.caseNumber, 'KDLA/2026/0001');
  assert.strictEqual(kase.attachments.length, 1);

  r = await a.req(`/cases/${caseId}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Mary Sampa vs John Mansa/);
  assert.match(r.text, /statement\.pdf/);

  r = await a.req(`/files/cases/${caseId}/${kase.attachments[0].id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, '%PDF-1.4 test');
  assert.strictEqual(r.headers.get('content-security-policy'), null, 'no page CSP on file downloads');

  // Case diary
  r = await a.post(`/cases/${caseId}/notes`, { type: 'Mediation session', date: today(), minutes: '90', text: 'Met both parties with the headman.' }, `/cases/${caseId}`);
  assert.strictEqual(r.status, 302);
  r = await a.post(`/cases/${caseId}/notes`, { type: 'Phone call', date: '2999-01-01', text: 'future' }, `/cases/${caseId}`);
  assert.strictEqual(r.status, 302);
  const notes = await db().find('caseNotes', { where: { caseId } });
  assert.strictEqual(notes.length, 1, 'future-dated note rejected');
  r = await a.req(`/cases/${caseId}`);
  assert.match(r.text, /Met both parties with the headman/);
  assert.match(r.text, /1\.5 hours/);

  // Tasks and hearings
  r = await a.post('/tasks', {
    title: 'Hearing at Kitwe Local Court', type: 'Court hearing', dueDate: today(3), dueTime: '09:30', assigneeId: officerId,
    location: 'Kitwe', caseId, returnTo: `/cases/${caseId}#tasks`,
  }, `/cases/${caseId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, `/cases/${caseId}#tasks`);
  const task = (await db().find('tasks', { where: { caseId } }))[0];
  r = await a.req(`/tasks/${task.id}/calendar.ics`);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.text, /DTSTART:\d{8}T073000Z/, 'Lusaka 09:30 is 07:30 UTC');
  await a.post('/tasks', { title: 'Overdue letter', type: 'Deadline', dueDate: today(-2), assigneeId: await userId('admin') }, '/tasks/new');
  r = await a.req('/tasks');
  assert.match(r.text, /Overdue \(1\)/);
  assert.match(r.text, /badge rounded-pill text-bg-danger/, 'overdue badge in navigation');
  const overdue = (await db().find('tasks', { where: { title: 'Overdue letter' } }))[0];
  await a.post(`/tasks/${overdue.id}/done`, { done: 'true' }, '/tasks');
  assert.strictEqual((await db().get('tasks', overdue.id)).done, true);

  // Edit with stale etag is rejected, fresh one works
  r = await a.post(`/cases/${caseId}`, {
    heading: 'Mary Sampa vs John Mansa', openedOn: '2026-03-02', caseTypes: ['Land and Property'], services: ['Legal Advice'], status: 'Open Inactive Case',
    officerId, clientIds: [clientId], _etag: 'stale',
  }, `/cases/${caseId}/edit`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await db().get('cases', caseId)).status, 'Open Active Case', 'stale edit must not save');

  // Concluding requires an outcome
  const etagOf = async () => (await a.req(`/cases/${caseId}/edit`)).text.match(/name="_etag" value="([^"]+)"/)[1];
  const caseFields = {
    heading: 'Mary Sampa vs John Mansa', openedOn: '2026-03-02', caseTypes: ['Land and Property'], services: ['Legal Advice'],
    officerId, clientIds: [clientId], defendantIds: [defendantId],
  };
  r = await a.post(`/cases/${caseId}`, { ...caseFields, status: 'Concluded Closed Case', _etag: await etagOf() }, `/cases/${caseId}/edit`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Select the outcome of the case/);

  r = await a.post('/stakeholders', { name: 'Legal Aid Board', contactPerson: 'Ms Phiri', phone: '0212 000000', address: 'Kitwe' }, '/stakeholders/new');
  assert.strictEqual(r.status, 302);
  const orgId = idFrom(r.location);

  r = await a.post('/referrals', { caseId, organizationId: orgId, followUp: 'Needs follow up', reason: 'Court representation', markReferred: 'on' }, '/referrals/new');
  assert.strictEqual(r.status, 302);
  const refId = idFrom(r.location);
  ctx.refId = refId;
  assert.strictEqual((await db().get('cases', caseId)).status, 'Open Referred');
  r = await a.req(`/referrals/${refId}/letter`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Dear Ms Phiri/);
  assert.match(r.text, /Yours sincerely/);
  assert.match(r.text, /123456\/78\/1/);

  r = await a.post(`/referrals/${refId}/follow-ups`, { description: 'Called LAB, hearing set.', status: 'Open Active Case', followUp: 'Does not need follow up' }, `/referrals/${refId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await db().get('cases', caseId)).status, 'Open Active Case');

  r = await a.post(`/cases/${caseId}`, {
    ...caseFields, status: 'Concluded Closed Case', outcome: 'Resolved through mediation', closedOn: today(),
    outcomeNotes: 'Land returned to the widow.', _etag: await etagOf(),
  }, `/cases/${caseId}/edit`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 400));
  const closed = await db().get('cases', caseId);
  assert.strictEqual(closed.outcome, 'Resolved through mediation');
  assert.ok(closed.history.some((x) => x.action === 'Outcome recorded'));

  // Report with attendance register
  r = await a.post('/reports', {
    activityType: 'Community Meeting', heading: 'Land rights meeting, Fisenge', date: today(-1), district: 'Kitwe District', location: 'Fisenge hall',
    introduction: 'Intro', objectives: 'Objectives', implementation: 'Implementation', otherParticipants: '30', projectId,
    compiledById: await userId('admin'),
  }, '/reports/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 500));
  const reportId = idFrom(r.location);
  r = await a.post(`/reports/${reportId}/attendees`, {
    'rows[0][firstName]': 'Ruth', 'rows[0][lastName]': 'Chanda', 'rows[0][ageCategory]': 'Girl', 'rows[0][age]': '15',
    'rows[1][firstName]': 'Peter', 'rows[1][lastName]': 'Mulenga', 'rows[1][ageCategory]': 'Man', 'rows[1][disability]': 'Disabled',
    // Blank rows still send the disability drop-down's default value; they must be ignored.
    'rows[2][firstName]': '', 'rows[2][lastName]': '', 'rows[2][disability]': 'Not Disabled',
    'rows[3][firstName]': '', 'rows[3][lastName]': '', 'rows[3][ageCategory]': '', 'rows[3][disability]': 'Not Disabled',
    consentRecord: 'yes',
  }, `/reports/${reportId}/attendees`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 500));
  const rep = await db().get('reports', reportId);
  assert.strictEqual(rep.attendeeIds.length, 2);
  r = await a.post(`/reports/${reportId}/attendees`, { 'rows[0][firstName]': 'Bad', 'rows[0][lastName]': 'Row', 'rows[0][ageCategory]': 'Boy', 'rows[0][age]': '30' }, `/reports/${reportId}/attendees`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Row 1:/);
  // Formatted text and the photo gallery
  r = await a.req(`/reports/${reportId}/edit`);
  assert.match(r.text, /\/vendor\/quill\/quill\.js/);
  assert.match(r.text, /data-rich/);
  r = await a.postMultipart(`/reports/${reportId}`, {
    activityType: 'Community Meeting', heading: 'Land rights meeting, Fisenge', date: today(-1), district: 'Kitwe District', location: 'Fisenge hall',
    introduction: '<p>Intro with <strong>bold</strong> and <span class="ql-size-large">large</span> text<script>x()</script></p>',
    objectives: 'Objectives', implementation: '<p>Implementation</p>', compiledById: await userId('admin'), attendeeIds: (await db().get('reports', reportId)).attendeeIds,
  }, [{ name: 'meeting-photo.png', type: 'image/png', content: Buffer.from('89504e470d0a1a0a', 'hex') }], `/reports/${reportId}/edit`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  r = await a.req(`/reports/${reportId}`);
  assert.match(r.text, /<strong>bold<\/strong>/);
  assert.match(r.text, /class="ql-size-large"/);
  assert.ok(!r.text.includes('x()</script>'));
  assert.match(r.text, /Photos \(1\)/);
  assert.match(r.text, /<img src="\/files\/reports\//);
  assert.match(r.text, /Ruth Chanda/);
  assert.match(r.text, /With a disability/);

  // Chat: officer cannot see a room until added
  const o = new Client();
  await o.login('officer1', 'officer-password-1');
  ctx.officer = o;
  r = await a.post('/rooms', { kind: 'case', name: 'No case chosen' }, '/rooms/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Select the case you want to consult on/);
  r = await a.post('/rooms', { kind: 'case', name: 'Advice on customary land', caseId }, '/rooms/new');
  const roomId = idFrom(r.location);
  r = await a.post('/rooms', { kind: 'management', name: 'Vehicle schedule', caseId }, '/rooms/new?kind=management');
  const mgmtId = idFrom(r.location);
  r = await a.req(`/rooms/${mgmtId}`);
  assert.match(r.text, /Management issue/);
  r = await a.req('/rooms?kind=case');
  assert.match(r.text, /Advice on customary land/);
  assert.doesNotMatch(r.text, /Vehicle schedule/);
  r = await a.req(`/cases/${caseId}`);
  assert.match(r.text, /Consultation rooms/);
  assert.match(r.text, new RegExp(`/rooms/${roomId}"`));
  assert.doesNotMatch(r.text, /Vehicle schedule/);
  r = await o.req(`/rooms/${roomId}`);
  assert.strictEqual(r.status, 403);
  await a.post(`/rooms/${roomId}/members`, { userId: officerId }, `/rooms/${roomId}`);
  await o.post(`/rooms/${roomId}/messages`, { content: 'Suggest mediation with the headman first.' }, `/rooms/${roomId}`);
  r = await a.req(`/rooms/${roomId}/messages.json`, { headers: { accept: 'application/json' } });
  const msgs = JSON.parse(r.text);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].sender, 'Mwila Banda');

  // Officers cannot delete
  r = await o.post(`/cases/${caseId}/delete`, {}, `/cases/${caseId}`);
  assert.strictEqual(r.status, 403);

  // Pages render
  for (const p of ['/', '/cases', '/cases?status=concluded&outcome=Resolved+through+mediation', '/people', '/people/clients',
    `/people/clients/${clientId}`, `/people/defendants/${defendantId}`, '/people/attendees', '/reports', `/reports/${reportId}`,
    `/reports/${reportId}/attendees`, '/stakeholders', `/stakeholders/${orgId}`, '/referrals', `/referrals/${refId}`, '/rooms',
    `/rooms/${roomId}`, '/search?q=sampa', '/admin/users', '/admin/projects', '/admin/audit', '/admin/export', '/account/password',
    '/account/security', '/account/appearance', '/tasks?who=all', '/tasks/new', `/tasks/${task.id}/edit`, '/conflicts',
    '/statistics', '/statistics?from=2026-01-01&to=2026-12-31&office=Fisenge+Office']) {
    r = await a.req(p);
    assert.strictEqual(r.status, 200, `${p} -> ${r.status} ${r.location || ''} ${r.text.slice(0, 300)}`);
  }
  r = await a.req('/search?q=123456');
  assert.match(r.text, /Mary Sampa/);
  r = await a.req(`/people/clients/${clientId}`);
  assert.match(r.text, /Record and store/);

  // Statistics
  r = await a.req(`/statistics?from=${today().slice(0, 4)}-01-01&to=${today()}`);
  assert.match(r.text, /Resolved through mediation/);
  assert.match(r.text, /100%/);
  r = await a.req(`/statistics/export.csv?from=${today().slice(0, 4)}-01-01&to=${today()}`);
  assert.match(r.text, /Cases concluded by outcome,Resolved through mediation,1/);

  // CSV exports
  r = await a.req('/cases/export.csv');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /KDLA\/2026\/0001/);
  assert.match(r.text, /Resolved through mediation/);
  r = await a.req('/people/clients/export.csv');
  assert.match(r.text, /Sampa/);
  r = await a.req('/reports/export.csv');
  assert.match(r.text, /Attendees: Girl/);

  // Data subject access export and full export exclude secrets
  r = await a.req(`/people/clients/${clientId}/data.json`);
  const subject = JSON.parse(r.text);
  assert.strictEqual(subject.person.lastName, 'Sampa');
  assert.strictEqual(subject.cases.length, 1);
  assert.strictEqual(subject.caseNotes.length, 1);
  r = await a.post('/admin/export', {}, '/admin/export');
  const dump = JSON.parse(r.text);
  assert.ok(dump.cases.length >= 1);
  assert.ok(dump.users.every((u) => !('passwordHash' in u)), 'password hashes never exported');

  // Audit trail recorded the work
  const auditRows = await db().find('audit', {});
  for (const action of ['login', 'login_failed', 'create', 'update', 'export', 'download']) {
    assert.ok(auditRows.some((x) => x.action === action), `audit has ${action}`);
  }
  r = await a.req(`/admin/audit?entityId=${caseId}`);
  assert.match(r.text, /Opened case KDLA\/2026\/0001/);
});

test('confidential cases are hidden from staff outside the case team', async () => {
  const a = ctx.admin;
  const o1 = ctx.officer;
  const o2 = new Client();
  await o2.login('officer2', 'officer-password-2');
  const officer1 = await userId('officer1');
  const officer2 = await userId('officer2');

  let r = await a.post('/people/clients', { firstName: 'Code', lastName: 'Name A', ageCategory: 'Woman', consentRecord: 'yes' }, '/people/clients/new');
  const clientId = idFrom(r.location);
  r = await a.postMultipart('/cases', {
    heading: 'GBV matter CN-A', openedOn: today(), caseTypes: ['Gender-Based Violence (GBV) related'], services: ['Legal Advice'],
    complaint: 'Sensitive details', status: 'Open Active Case', officerId: officer1, clientIds: [clientId], restricted: 'on',
  }, [{ name: 'medical.pdf', type: 'application/pdf', content: '%PDF secret' }], '/cases/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const caseId = idFrom(r.location);
  const kase = await db().get('cases', caseId);
  assert.strictEqual(kase.restricted, true);

  // Officer 1 (responsible) can open it; officer 2 cannot
  r = await o1.req(`/cases/${caseId}`);
  assert.strictEqual(r.status, 200);
  r = await o2.req(`/cases/${caseId}`);
  assert.strictEqual(r.status, 403);
  assert.doesNotMatch(r.text, /Sensitive details/);
  r = await o2.req(`/files/cases/${caseId}/${kase.attachments[0].id}`);
  assert.strictEqual(r.status, 403);
  r = await o2.req('/cases');
  assert.doesNotMatch(r.text, /GBV matter CN-A/);
  r = await o2.req('/search?q=GBV');
  assert.doesNotMatch(r.text, /GBV matter CN-A/);
  r = await o2.req('/cases/export.csv');
  assert.doesNotMatch(r.text, /GBV matter/);
  r = await o2.req(`/people/clients/${clientId}`);
  assert.match(r.text, /Confidential case/);
  assert.doesNotMatch(r.text, /GBV matter CN-A/);
  r = await o2.req('/');
  assert.doesNotMatch(r.text, /GBV matter CN-A/);

  // Adding officer 2 to the case team gives access
  const etag = (await o1.req(`/cases/${caseId}/edit`)).text.match(/name="_etag" value="([^"]+)"/)[1];
  r = await o1.post(`/cases/${caseId}`, {
    heading: 'GBV matter CN-A', openedOn: today(), caseTypes: ['Gender-Based Violence (GBV) related'], services: ['Legal Advice'],
    complaint: 'Sensitive details', status: 'Open Active Case', officerId: officer1, clientIds: [clientId], restricted: 'on', teamIds: [officer2], _etag: etag,
  }, `/cases/${caseId}/edit`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  r = await o2.req(`/cases/${caseId}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Sensitive details/);

  // Blocked and allowed views are in the audit trail
  const entries = await db().find('audit', { where: { entityId: caseId } });
  assert.ok(entries.some((e) => /Blocked: confidential case/.test(e.summary)));
  assert.ok(entries.some((e) => /Viewed confidential case/.test(e.summary)));
});

test('password change signs out other devices; appearance is saved', async () => {
  const d1 = new Client(); const d2 = new Client();
  await d1.login('officer2', 'officer-password-2');
  await d2.login('officer2', 'officer-password-2');
  let r = await d1.post('/account/password', { current: 'officer-password-2', password: 'new-pass-for-chanda', confirm: 'new-pass-for-chanda' }, '/account/password');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  r = await d1.req('/');
  assert.strictEqual(r.status, 200, 'this device stays signed in');
  r = await d2.req('/');
  assert.strictEqual(r.status, 302, 'other device is signed out');
  assert.match(r.location, /\/login\?expired=1/);

  const token = await d1.csrf('/account/appearance');
  r = await d1.req('/account/appearance', {
    method: 'POST', body: 'mode=dark&accent=blue&textSize=large',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-csrf-token': token },
  });
  assert.strictEqual(r.status, 200);
  r = await d1.req('/');
  assert.match(r.text, /data-theme-mode="dark" data-bs-theme="dark" data-accent="blue" data-text-size="large"/);
});

test('two-step verification with authenticator code and recovery code', async () => {
  const c = new Client();
  await c.login('officer1', 'officer-password-1');
  let r = await c.req('/account/security');
  const secret = r.text.match(/user-select-all">([A-Z2-7 ]+)</)[1].replace(/\s/g, '');
  r = await c.post('/account/security/enable', { code: '000000' }, '/account/security');
  assert.strictEqual(r.status, 400);
  const code = totp.hotp(totp.base32Decode(secret), totp.currentStep());
  r = await c.post('/account/security/enable', { code }, '/account/security');
  assert.strictEqual(r.status, 200);
  const codes = [...r.text.matchAll(/<li>([a-z2-7]{4}-[a-z2-7]{4})<\/li>/g)].map((m) => m[1]);
  assert.strictEqual(codes.length, 8);

  const fresh = new Client();
  r = await fresh.login('officer1', 'officer-password-1');
  assert.strictEqual(r.location, '/login/verify');
  r = await fresh.req('/cases');
  assert.strictEqual(r.status, 302, 'not logged in until verified');
  r = await fresh.post('/login/verify', { code: '111111' }, '/login/verify');
  assert.strictEqual(r.status, 401);
  r = await fresh.post('/login/verify', { code: codes[0].toUpperCase() }, '/login/verify');
  assert.strictEqual(r.status, 302);
  r = await fresh.req('/cases');
  assert.strictEqual(r.status, 200);
  const u = (await db().find('users', { where: { username: 'officer1' } }))[0];
  assert.strictEqual(u.recoveryCodes.length, 7, 'used recovery code is removed');

  // Admin can reset it for a lost phone
  r = await ctx.admin.post(`/admin/users/${u.id}`, { fullName: 'Mwila Banda', role: 'officer', active: 'on', reset2fa: 'on' }, `/admin/users/${u.id}/edit`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await db().get('users', u.id)).totpEnabled, false);
  r = await fresh.req('/cases');
  assert.strictEqual(r.status, 302, 'reset signs the user out');
});

test('admin deletes a case with its diary, tasks and referrals', async () => {
  const r = await ctx.admin.post(`/cases/${ctx.caseId}/delete`, {}, `/cases/${ctx.caseId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await db().get('cases', ctx.caseId), null);
  assert.strictEqual(await db().get('referrals', ctx.refId), null);
  assert.strictEqual((await db().find('caseNotes', { where: { caseId: ctx.caseId } })).length, 0);
  assert.strictEqual((await db().find('tasks', { where: { caseId: ctx.caseId } })).length, 0);
});

test('administrators manage the districts and offices lists', async () => {
  const choices = require('../src/choices');
  const { loadLists } = require('../src/lists');
  const before = [...choices.districts];
  let r = await ctx.admin.req('/admin/lists');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Kitwe District/);
  r = await ctx.admin.post('/admin/lists/districts', { values: '   \n' }, '/admin/lists');
  assert.strictEqual(r.status, 400, 'an empty list is refused');
  r = await ctx.admin.post('/admin/lists/districts', { values: 'Kitwe District\nMufulira District\nkitwe district\n' }, '/admin/lists');
  assert.strictEqual(r.status, 302);
  assert.deepStrictEqual(choices.districts, ['Kitwe District', 'Mufulira District'], 'repeats are dropped');
  // The saved list survives a restart.
  choices.districts.splice(0, choices.districts.length, ...before);
  await loadLists(db());
  assert.deepStrictEqual(choices.districts, ['Kitwe District', 'Mufulira District']);
  r = await ctx.admin.req('/reports/new');
  assert.match(r.text, /Mufulira District/);
  assert.ok(!r.text.includes('<option value="Lufwanyama District"'), 'removed districts are no longer offered');
  await createUser(db(), { username: 'officer3', password: 'officer-password-3', fullName: 'List Tester' });
  const o = new Client();
  await o.login('officer3', 'officer-password-3');
  r = await o.req('/admin/lists');
  assert.strictEqual(r.status, 403, 'officers cannot change the lists');
  r = await ctx.admin.post('/admin/lists/offices', { values: [...choices.offices, 'Luanshya Office'].join('\n') }, '/admin/lists');
  assert.strictEqual(r.status, 302);
  assert.ok(choices.offices.includes('Luanshya Office'));
});

test('infographic page draws the period summary', async () => {
  let r = await ctx.admin.req(`/statistics/infographic?from=${today().slice(0, 4)}-01-01&to=${today()}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /in numbers/);
  assert.match(r.text, /<svg class="viz"/);
  assert.match(r.text, /Cases opened each month/);
  r = await ctx.admin.req('/statistics/infographic?from=2026-12-31&to=2026-01-01');
  assert.match(r.text, /start date must be before/);
  r = await ctx.admin.req('/statistics');
  assert.match(r.text, /\/statistics\/infographic\?/);
});

test('phone app: manifest, service worker and offline page work without login', async () => {
  let r = await fetch(`${base}/sw.js`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
  const sw = await r.text();
  assert.doesNotMatch(sw, /__ASSET_VERSION__/);
  assert.match(sw, /request\.mode === 'navigate'/);
  r = await fetch(`${base}/offline`);
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /No internet connection/);
  r = await fetch(`${base}/static/manifest.webmanifest`);
  const m = JSON.parse(await r.text());
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.strictEqual((await fetch(base + i.src)).status, 200);
  r = await ctx.admin.req('/account/app');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Add to Home Screen/);
  assert.match(r.text, /rel="manifest"/);
});

test('work plans: draft, planned activities, approval, linked reports and progress', async () => {
  const a = ctx.admin;
  const o = new Client();
  await o.login('officer3', 'officer-password-3');
  const officerId = await userId('officer3');
  const start = today(-60); const end = today(60);
  const planOf = (id) => db().get('workplans', id);

  // An officer starts a draft plan
  let r = await o.post('/workplans', { title: '', periodStart: start, periodEnd: end }, '/workplans/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Enter a title/);
  r = await o.post('/workplans', { title: 'Kitwe outreach plan', periodStart: end, periodEnd: start }, '/workplans/new');
  assert.match(r.text, /The end must be on or after the start/);
  r = await o.post('/workplans', {
    title: 'Kitwe outreach plan', periodStart: start, periodEnd: end, office: 'Fisenge Office', currency: 'ZMW', notes: 'Land rights outreach',
  }, '/workplans/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const planId = idFrom(r.location);
  assert.strictEqual((await planOf(planId)).status, 'Draft');
  assert.strictEqual((await planOf(planId)).preparedById, officerId);

  // Planned activities: numbered automatically, unique numbers, dates inside the period
  r = await o.post(`/workplans/${planId}/activities`, {
    number: '', title: 'Community sensitisation on customary land', activityType: 'Community Meeting', district: 'Kitwe District',
    responsibleId: officerId, startDate: today(-30), endDate: today(-1), targetEvents: '2', targetPeople: '100', budget: '1,500.50',
    output: '100 people know how to register customary land', status: 'Not started', next: 'another',
  }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  assert.strictEqual(r.location, `/workplans/${planId}/activities/new`, '"Add and add another" opens a new form');
  let plan = await planOf(planId);
  const first = plan.items[0];
  assert.strictEqual(first.number, 1);
  assert.strictEqual(first.budget, 1500.5);
  r = await o.post(`/workplans/${planId}/activities`, { number: '1', title: 'Radio programme', status: 'Not started' }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Activity number 1 is already used/);
  r = await o.post(`/workplans/${planId}/activities`, { title: 'Radio programme', endDate: today(90), status: 'Not started' }, `/workplans/${planId}/activities/new`);
  assert.match(r.text, /within the plan period/);
  r = await o.post(`/workplans/${planId}/activities`, {
    number: '5', title: 'Radio programme on land rights', activityType: 'Radio or TV Program', responsibleId: officerId,
    startDate: today(1), endDate: today(10), targetEvents: '1', status: 'Not started',
  }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  plan = await planOf(planId);
  const second = plan.items.find((it) => it.number === 5);
  assert.deepStrictEqual(plan.items.map((it) => it.number), [1, 5]);

  r = await o.req(`/workplans/${planId}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Community sensitisation on customary land/);
  assert.match(r.text, /<span class="tag tag-danger">Overdue<\/span>/);
  assert.match(r.text, new RegExp(`/reports/new\\?workplanItem=${planId}:${first.id}`));

  // Only administrators approve; then only they change the activities, but anyone updates progress
  r = await o.post(`/workplans/${planId}/status`, { status: 'Approved' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).status, 'Draft');
  r = await a.post(`/workplans/${planId}/status`, { status: 'Approved' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  plan = await planOf(planId);
  assert.strictEqual(plan.status, 'Approved');
  assert.strictEqual(plan.approvedById, await userId('admin'));
  r = await o.req(`/workplans/${planId}/activities/${first.id}/edit`);
  assert.strictEqual(r.status, 302, 'approved plan: no edit form for officers');
  r = await o.post(`/workplans/${planId}/activities/${first.id}`, { title: 'Changed', status: 'Not started' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).items[0].title, 'Community sensitisation on customary land');
  r = await o.post(`/workplans/${planId}/activities/${first.id}/progress`, { status: 'In progress' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).items[0].status, 'In progress');

  // Two colleagues updating different activities at the same moment do not overwrite each other
  const wp = require('../src/services/workplans');
  const stale = await planOf(planId);
  const adminUser = (await db().find('users', { where: { username: 'admin' } }))[0];
  const fakeReq = { db: db(), user: adminUser, ip: '127.0.0.1' };
  await wp.setActivityStatus(fakeReq, stale, first.id, 'Postponed');
  await wp.setActivityStatus(fakeReq, stale, second.id, 'In progress');
  plan = await planOf(planId);
  assert.deepStrictEqual(plan.items.map((it) => it.status), ['Postponed', 'In progress'], 'the second change was applied to the latest version');
  await wp.setActivityStatus(fakeReq, plan, first.id, 'In progress');

  // An activity report written from the plan is linked to the planned activity
  r = await o.req(`/reports/new?workplanItem=${planId}:${first.id}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, new RegExp(`value="${planId}:${first.id}" selected`));
  assert.match(r.text, /value="Community sensitisation on customary land"/);
  const reportFields = {
    activityType: 'Community Meeting', heading: 'Sensitisation in Chamboli', date: today(-2), district: 'Kitwe District',
    introduction: 'Intro', objectives: 'Objectives', implementation: 'Implementation', otherParticipants: '40', compiledById: officerId,
  };
  r = await o.post('/reports', { ...reportFields, workplanItem: `${planId}:not-an-activity` }, '/reports/new');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Select a valid work plan activity/);
  r = await o.post('/reports', { ...reportFields, workplanItem: `${planId}:${first.id}`, activityNumber: '' }, '/reports/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const reportId = idFrom(r.location);
  const report = await db().get('reports', reportId);
  assert.strictEqual(report.workplanId, planId);
  assert.strictEqual(report.workplanItemId, first.id);
  assert.strictEqual(report.activityNumber, 1, 'activity number taken from the plan');
  r = await o.req(`/reports/${reportId}`);
  assert.match(r.text, new RegExp(`/workplans/${planId}#act-${first.id}`));
  r = await o.req(`/reports/${reportId}/edit`);
  assert.match(r.text, new RegExp(`value="${planId}:${first.id}" selected`), 'edit form keeps the link');

  // Planned against delivered
  const { items, totals } = await wp.progress(db(), await planOf(planId));
  assert.strictEqual(items[0].delivered, 1);
  assert.strictEqual(items[0].reached, 40);
  assert.strictEqual(items[0].eventsPct, 50);
  assert.strictEqual(items[0].overdue, true);
  assert.strictEqual(totals.delivered, 1);
  assert.strictEqual(totals.targetEvents, 3);
  r = await o.req(`/workplans/${planId}`);
  assert.match(r.text, new RegExp(`/reports/${reportId}"`));
  r = await o.req(`/workplans/${planId}/export.csv`);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /Delivered \(activity reports\)/);
  assert.match(r.text, /1,Community sensitisation on customary land,Community Meeting,Kitwe District,List Tester/);
  r = await o.req('/');
  assert.match(r.text, /My work plan activities/);
  assert.match(r.text, /Radio programme on land rights/);
  r = await o.req('/workplans?status=Approved');
  assert.match(r.text, /Kitwe outreach plan/);
  r = await o.req('/workplans?status=Closed');
  assert.doesNotMatch(r.text, /Kitwe outreach plan/);

  // Copy for the next period: the activities move with the start of the plan
  r = await o.post(`/workplans/${planId}/copy`, {}, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /\/edit$/);
  const copyId = r.location.split('/')[2];
  let copy = await planOf(copyId);
  assert.strictEqual(copy.status, 'Draft');
  assert.ok(copy.items.every((it) => it.status === 'Not started'));
  assert.ok(copy.items.every((it) => !plan.items.some((x) => x.id === it.id)), 'activities get new ids');
  r = await o.req(`/workplans/${copyId}/edit`);
  assert.match(r.text, /Move the activity dates with the plan/);
  const moved = { title: 'Kitwe outreach plan, next period', periodStart: today(-20), periodEnd: today(100), office: 'Fisenge Office', currency: 'ZMW' };
  r = await o.post(`/workplans/${copyId}`, { ...moved, _etag: copy._etag }, `/workplans/${copyId}/edit`);
  assert.strictEqual(r.status, 400, 'without moving, the first activity would start before the plan');
  assert.match(r.text, /dates outside this period/);
  r = await o.post(`/workplans/${copyId}`, { ...moved, moveActivities: 'on', _etag: copy._etag }, `/workplans/${copyId}/edit`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 400));
  copy = await planOf(copyId);
  assert.deepStrictEqual(copy.items.map((it) => [it.startDate, it.endDate]), [[today(10), today(39)], [today(41), today(50)]], 'moved 40 days with the start');

  // Closed plans cannot change until an administrator reopens them; reopening keeps the approval
  const approvedAt = (await planOf(planId)).approvedAt;
  r = await a.post(`/workplans/${planId}/status`, { status: 'Closed' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).status, 'Closed');
  r = await o.post(`/workplans/${planId}/activities/${first.id}/progress`, { status: 'Completed' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).items[0].status, 'In progress');
  r = await a.req(`/workplans/${planId}`);
  assert.doesNotMatch(r.text, new RegExp(`/workplans/${planId}/activities/new`), 'no editing a closed plan, even for administrators');
  r = await a.post(`/workplans/${planId}/status`, { status: 'Approved' }, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  plan = await planOf(planId);
  assert.strictEqual(plan.status, 'Approved');
  assert.strictEqual(plan.approvedAt, approvedAt);

  // Removing an activity or a plan keeps the reports and unlinks them
  r = await o.post(`/workplans/${planId}/delete`, {}, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.ok(await planOf(planId), 'officers cannot delete a plan');
  r = await a.post(`/workplans/${planId}/activities/${first.id}/delete`, {}, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await planOf(planId)).items.length, 1);
  assert.strictEqual((await db().get('reports', reportId)).workplanId, '');
  r = await a.post(`/workplans/${planId}/delete`, {}, `/workplans/${planId}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await planOf(planId), null);
  assert.ok(await db().get('reports', reportId), 'the report is kept');

  for (const p of ['/workplans', '/workplans/new', `/workplans/${copyId}`, `/workplans/${copyId}/edit`, `/workplans/${copyId}/activities/new`,
    `/workplans/${copyId}/activities/${copy.items[0].id}/edit`, '/reports/new']) {
    r = await o.req(p);
    assert.strictEqual(r.status, 200, `${p} -> ${r.status} ${r.location || ''}`);
  }
});

test('M&E: logframe import, planned activities linked to it, automatic and recorded indicators', async () => {
  const a = ctx.admin;
  const o = new Client();
  await o.login('officer3', 'officer-password-3');
  const lf = require('../src/services/logframes');
  let r = await a.post('/admin/projects', {
    title: 'Copperbelt Access to Justice', donor: 'DIHR', startDate: today(-100), endDate: today(265), budget: '600000', currency: 'DKK',
  }, '/admin/projects/new');
  assert.strictEqual(r.status, 302);
  const pid = (await db().find('projects', { where: { title: 'Copperbelt Access to Justice' } }))[0].id;
  const fwOf = () => db().get('logframes', pid);

  // Only administrators set up and change the logframe
  r = await o.req('/logframes');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Copperbelt Access to Justice/);
  assert.match(r.text, /Not set up/);
  r = await o.post(`/logframes/${pid}`, {}, '/logframes');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await fwOf(), null);
  r = await a.post(`/logframes/${pid}`, {}, '/logframes');
  assert.strictEqual(r.status, 302);
  assert.ok(await fwOf());

  // Import from spreadsheet rows: nothing is saved while a row has a problem
  r = await a.post(`/logframes/${pid}/import`, { outline: 'Level,Code,Text\nOutput,,An output without its objective\nPlanet,,x' }, `/logframes/${pid}/import`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Row 2: put this output under an intermediate objective/);
  assert.match(r.text, /Row 3: &#34;Planet&#34; is not a level|Row 3: &quot;Planet&quot; is not a level/);
  assert.strictEqual((await fwOf()).results.length, 0);
  const outline = [
    'Level,Code,Text,Unit,Baseline,Target,Means of verification,Source',
    'Overall objective,,To expand legal empowerment and access to justice',
    'Intermediate objective,,Improved understanding and awareness of rights',
    'Output,,"At least 100 community members (60% women) are reached through awareness raising"',
    'Indicator,,Community members reached,Number,0,100,Attendance registers,People reached',
    'Indicator,,Share of women and girls,Percent,0,60,Attendance registers,Women and girls (%)',
    'Activity,,Community awareness-raising by paralegals',
    'Intermediate objective,,Strengthened paralegal legal desks',
    'Output,,5 community legal desks are operational',
    'Indicator,,Legal desks operational,Number,0,5,Supervision reports,',
    'Activity,,Support community legal desks financially',
  ].join('\n');
  r = await a.post(`/logframes/${pid}/import`, { outline }, `/logframes/${pid}/import`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 400));
  let fw = await fwOf();
  assert.strictEqual(fw.results.length, 7);
  assert.strictEqual(fw.indicators.length, 3);
  r = await a.post(`/logframes/${pid}/import`, { outline }, `/logframes/${pid}/import`);
  assert.strictEqual(r.status, 400, 'import works on an empty logframe only');
  assert.match(r.text, /already has entries/);
  const awareness = fw.results.find((x) => x.text === 'Community awareness-raising by paralegals');
  const desks = fw.results.find((x) => x.text === '5 community legal desks are operational');
  r = await o.req(`/logframes/${pid}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Output 1\.1/);
  assert.match(r.text, /Activity 2\.1\.1/);
  assert.match(r.text, /No planned activities linked yet/);
  r = await o.req(`/logframes/${pid}/results/new?level=output&parent=${fw.results[1].id}`);
  assert.strictEqual(r.status, 302, 'officers cannot add results');

  // A planned activity of a work plan for the project links to the logframe activity
  r = await a.post('/workplans', { title: 'Copperbelt plan', periodStart: today(-30), periodEnd: today(60), projectId: pid, currency: 'ZMW' }, '/workplans/new');
  const planId = idFrom(r.location);
  r = await a.req(`/workplans/${planId}/activities/new`);
  assert.match(r.text, /Contributes to \(logframe\)/);
  assert.match(r.text, new RegExp(`value="${pid}:${awareness.id}"`));
  r = await a.post(`/workplans/${planId}/activities`, { title: 'Wrong link', status: 'Not started', logframeResult: `${pid}:${fw.results[0].id}` }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /Choose an output or an activity of the logframe/);
  r = await a.post(`/workplans/${planId}/activities`, {
    title: 'Awareness meetings in Mufulira', status: 'In progress', targetEvents: '2', targetPeople: '100', logframeResult: `${pid}:${awareness.id}`,
  }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  r = await a.post(`/workplans/${planId}/activities`, { title: 'Office planning meeting', status: 'Not started' }, `/workplans/${planId}/activities/new`);
  assert.strictEqual(r.status, 302);
  let plan = await db().get('workplans', planId);
  const linkedItem = plan.items.find((it) => it.title === 'Awareness meetings in Mufulira');
  assert.strictEqual(linkedItem.logframeResultId, awareness.id);
  r = await a.req(`/workplans/${planId}`);
  assert.match(r.text, /Activity 1\.1\.1/);

  // Its activity report, with an attendance register, feeds the automatic indicators
  r = await a.post('/reports', {
    activityType: 'Community Meeting', heading: 'Awareness meeting, Kantanshi', date: today(-3), district: 'Kitwe District',
    introduction: 'Intro', objectives: 'Objectives', implementation: 'Implementation', otherParticipants: '10', compiledById: await userId('admin'),
    workplanItem: `${planId}:${linkedItem.id}`,
  }, '/reports/new');
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  const reportId = idFrom(r.location);
  r = await a.post(`/reports/${reportId}/attendees`, {
    'rows[0][firstName]': 'Ruth', 'rows[0][lastName]': 'Bwalya', 'rows[0][ageCategory]': 'Girl', 'rows[0][age]': '14',
    'rows[1][firstName]': 'Mary', 'rows[1][lastName]': 'Zulu', 'rows[1][ageCategory]': 'Woman',
    'rows[2][firstName]': 'Peter', 'rows[2][lastName]': 'Banda', 'rows[2][ageCategory]': 'Man', 'rows[2][disability]': 'Disabled',
    consentRecord: 'yes',
  }, `/reports/${reportId}/attendees`);
  assert.strictEqual(r.status, 302);
  r = await a.req(`/reports/${reportId}`);
  assert.match(r.text, /Logframe: <a href="\/logframes\//);

  const project = await db().get('projects', pid);
  let prog = await lf.progress(db(), await fwOf(), project);
  const ind = (name) => prog.results.flatMap((x) => x.indicators).find((i) => i.name === name);
  assert.strictEqual(ind('Community members reached').actual, 13, '3 registered attendees plus 10 counted');
  assert.strictEqual(ind('Community members reached').status, 'Behind', '13% of the target with about 27% of the time gone');
  assert.strictEqual(ind('Share of women and girls').actual, 66.7);
  assert.strictEqual(ind('Share of women and girls').status, 'Achieved');
  assert.strictEqual(ind('Legal desks operational').status, 'No data');
  const out = prog.results.find((x) => x.level === 'output' && x.text.startsWith('At least 100'));
  assert.strictEqual(out.rollup.planned, 1);
  assert.strictEqual(out.rollup.delivered, 1);
  assert.strictEqual(prog.results[0].rollup.reach, 13, 'the overall objective counts everything');
  assert.strictEqual(prog.totals.unlinked, 1, 'the office planning meeting is not linked');
  r = await o.req(`/logframes/${pid}`);
  assert.match(r.text, /Office planning meeting/);

  // Everyone records values of indicators measured by staff; automatic ones take none
  const deskInd = ind('Legal desks operational');
  r = await o.req(`/logframes/${pid}/indicators/${deskInd.id}`);
  assert.strictEqual(r.status, 200);
  r = await o.post(`/logframes/${pid}/indicators/${deskInd.id}/values`, { date: today(5), value: '2' }, `/logframes/${pid}/indicators/${deskInd.id}`);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /cannot be in the future/);
  r = await o.post(`/logframes/${pid}/indicators/${deskInd.id}/values`, { date: today(), value: '2', note: 'Kitwe and Kalulushi desks' }, `/logframes/${pid}/indicators/${deskInd.id}`);
  assert.strictEqual(r.status, 302);
  r = await o.post(`/logframes/${pid}/indicators/${ind('Community members reached').id}/values`, { date: today(), value: '50' }, `/logframes/${pid}`);
  assert.strictEqual(r.status, 302);
  prog = await lf.progress(db(), await fwOf(), project);
  assert.strictEqual(ind('Legal desks operational').actual, 2);
  assert.strictEqual(ind('Legal desks operational').status, 'On track');
  assert.strictEqual(ind('Community members reached').actual, 13, 'automatic values cannot be overwritten');

  // Administrators add, change and remove indicators and results
  fw = await fwOf();
  r = await a.post(`/logframes/${pid}/indicators`, {
    resultId: fw.results[0].id, name: 'Cases opened with legal aid', source: 'casesOpened', target: '200', baseline: '0',
  }, `/logframes/${pid}/indicators/new`);
  assert.strictEqual(r.status, 302, r.text.slice(0, 300));
  r = await a.post(`/logframes/${pid}/results/${desks.id}/delete`, {}, `/logframes/${pid}`);
  assert.strictEqual(r.status, 302);
  assert.ok((await fwOf()).results.some((x) => x.id === desks.id), 'an output with activities under it is kept');
  r = await a.post(`/logframes/${pid}/settings`, { name_objective: 'Goal', name_outcome: 'Outcome', name_output: 'Output', name_activity: 'Activity', notes: 'Full results framework in the project document' }, `/logframes/${pid}/settings`);
  assert.strictEqual(r.status, 302);
  r = await a.req(`/logframes/${pid}`);
  assert.match(r.text, /Outcome 2/);
  assert.match(r.text, /Cases opened with legal aid/);

  r = await a.req(`/logframes/${pid}/export.csv`);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /Indicator,,Community members reached,Number,0,100,Attendance registers,People reached,13/);
  assert.match(r.text, /Achieved/);
  r = await a.req('/logframes/template.csv');
  assert.match(r.text, /^\uFEFF?Level,Code,Text/, 'the template opens in Excel (fetch drops the byte order mark)');

  // A project with a logframe cannot be deleted; deleting the logframe unlinks the planned activities
  r = await a.post(`/admin/projects/${pid}/delete`, {}, '/admin/projects');
  assert.strictEqual(r.status, 302);
  assert.ok(await db().get('projects', pid), 'refused while the logframe exists');
  r = await a.post(`/logframes/${pid}/delete`, {}, `/logframes/${pid}/settings`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await fwOf(), null);
  plan = await db().get('workplans', planId);
  assert.strictEqual(plan.items.find((it) => it.id === linkedItem.id).logframeId, '');

  for (const p of ['/logframes', `/logframes/${pid}`]) {
    r = await o.req(p);
    assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
  }
});
