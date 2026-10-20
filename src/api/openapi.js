'use strict';
// OpenAPI 3.1 description of the API. Served at /api/v1/openapi.json (import it into Postman,
// Insomnia, Power BI or a code generator) and rendered as the readable page at /api/docs.
const choices = require('../choices');
const config = require('../config');
const pkg = require('../../package.json');

// ---------- Schema helpers ----------
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const E = (values, description) => ({ type: 'string', enum: values, ...(description && { description }) });
const D = (description) => ({ type: 'string', format: 'date', description: `${description} (YYYY-MM-DD)` });
const T = (description) => ({ type: 'string', format: 'date-time', description });
const B = (description) => ({ type: 'boolean', description });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const A = (items, description) => ({ type: 'array', items, ...(description && { description }) });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties, required = [], description) => ({
  type: 'object', ...(description && { description }), properties, ...(required.length && { required }),
});
const ids = (what) => A({ type: 'string' }, `Ids of ${what}`);
const tally = A(obj({ label: S('Category'), count: { type: 'number' } }));

const record = {
  id: S('Unique id', { readOnly: true }),
  createdAt: T('When the record was created'),
  updatedAt: T('When the record was last changed'),
  etag: S('Version tag. Send it back in an If-Match header when you change the record, to avoid overwriting someone else\'s changes.', { readOnly: true }),
};

const caseFields = {
  heading: S('Short title, for example "John Mansa vs Mary Sampa"'),
  openedOn: D('Date the case was opened, not in the future. Defaults to today'),
  caseTypes: A(E(choices.caseTypes), 'At least one type of case'),
  services: A(E(choices.legalServices), 'At least one legal service offered'),
  complaint: S('What the client complains about'),
  defence: S('What the other party says'),
  actionTaken: S('Action taken so far'),
  status: E(choices.caseStatuses, 'Defaults to "Open Active Case"'),
  officerId: S('Responsible officer (a user id). Defaults to you'),
  teamIds: ids('colleagues on the case team (they can open a confidential case)'),
  clientIds: ids('clients (complainants); at least one'),
  defendantIds: ids('other parties (defendants)'),
  office: E(['', ...choices.offices], 'Office handling the case. Defaults to your office'),
  restricted: B('Confidential case: only the officer, the case team and administrators can open it'),
  outcome: E(['', ...choices.caseOutcomes], 'Required when the status is a "Concluded" one'),
  outcomeNotes: S('Notes on the outcome'),
  closedOn: D('Date concluded. Defaults to today when the case is concluded'),
};

const personFields = {
  kind: E(['client', 'defendant', 'attendee'], 'client, defendant (other party) or attendee (of an activity). Cannot be changed later'),
  firstName: S('First name'),
  lastName: S('Last name'),
  nrc: S('National Registration Card number, 123456/78/1 (9 digits are also accepted)'),
  contact: S('Phone or other contact'),
  age: I('Age in years', { minimum: 0, maximum: 120 }),
  ageCategory: E(choices.ageCategories, 'Girl and Boy are under 18; Woman and Man are 18 or over'),
  civilStatus: E(['', ...choices.civilStatuses]),
  disability: E(['', ...choices.disability]),
  projectId: S('Project the person is registered under'),
  location: S('Village or area'),
  caseNumber: S('Clients only: client file number'),
  referralSource: E(['', ...choices.activities], 'Clients only: how they heard about the organisation'),
  versusClientId: S('Other parties only: the client they are in a dispute with'),
  activity: E(['', ...choices.activities], 'Attendees only: type of activity attended'),
  consentRecord: E(['', 'yes', 'no'], 'Clients and attendees: agreed to their information being recorded'),
  consentShare: E(['', 'yes', 'no'], 'Clients and attendees: agreed to their information being shared on referral'),
};

const taskFields = {
  title: S('What needs doing'),
  type: E(choices.taskTypes, 'Defaults to "Task"'),
  dueDate: D('Due date'),
  dueTime: S('Time, 24-hour HH:MM, in the organisation\'s time zone'),
  location: S('Where, for hearings and meetings'),
  assigneeId: S('Person responsible (a user id). Defaults to you'),
  caseId: S('Case the task belongs to'),
  notes: S('Notes'),
};

const reportFields = {
  activityType: E(choices.activities),
  heading: S('Heading'),
  activityNumber: I('Activity number from the work plan'),
  date: D('Date of the activity. Defaults to today'),
  district: E(['', ...choices.districts]),
  location: S('Venue'),
  projectId: S('Project'),
  introduction: S('Introduction'),
  objectives: S('Objectives'),
  implementation: S('How the activity was carried out'),
  immediateResults: S('Immediate results'),
  challenges: S('Challenges'),
  recommendations: S('Recommendations'),
  attendeeIds: ids('registered attendees (people of kind "attendee")'),
  otherParticipants: I('Participants who were not registered individually', { minimum: 0 }),
  compiledById: S('Who compiled the report (a user id). Defaults to you'),
};

const stakeholderFields = {
  name: S('Organisation name'),
  description: S('What the organisation does'),
  services: S('Services offered'),
  address: S('Address'),
  contactPerson: S('Contact person'),
  phone: S('Phone'),
  email: S('Email'),
};

const projectFields = {
  title: S('Project title'),
  donor: S('Donor'),
  description: S('Description'),
  startDate: D('Start date'),
  endDate: D('End date'),
  budget: { type: ['number', 'null'], description: 'Budget amount' },
  currency: E(['ZMW', 'DKK', 'USD', 'EUR', 'GBP'], 'Defaults to ZMW'),
};

const userFields = {
  username: S('Sign-in name: 3 or more lower-case letters, numbers, dots, dashes or underscores'),
  fullName: S('Full name'),
  email: S('Email'),
  role: E(choices.roles, 'officer or admin'),
  category: E(['', ...choices.userCategories]),
  qualification: E(['', ...choices.qualificationLevels]),
  office: E(['', ...choices.offices]),
  active: B('False stops the person signing in'),
};

const attachment = obj({
  id: S('File id'), name: S('File name'), size: I('Size in bytes'), type: S('Media type'),
  uploadedAt: T('Uploaded at'), uploadedBy: S('User id'), downloadUrl: S('Where to download it (needs your token)'),
});

const schemas = {
  Error: obj({
    error: obj({
      code: S('Machine-readable code, for example validation_failed, not_found, confidential, precondition_failed'),
      message: S('Explanation you can show to a person'),
      fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'validation_failed: one message per field' },
      matches: { type: 'object', description: 'possible_matches: duplicates and conflicts of interest found' },
      rowErrors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Attendance register: one message per row number (counting from 0)' },
    }, ['code', 'message']),
  }, ['error']),
  Attachment: attachment,
  Case: obj({
    ...record,
    caseNumber: S('Case number, for example KDLA/2026/0001', { readOnly: true }),
    ...caseFields,
    attachments: A(ref('Attachment')),
    history: A(obj({ at: T('When'), by: S('User id'), action: S('What happened'), status: S('New value'), from: S('Old value') }), 'Status changes and other events'),
    daysOpen: I('Days from opening to closing (or to today)', { readOnly: true }),
    createdBy: S('User id'),
  }),
  CaseInput: obj(caseFields, ['heading', 'caseTypes', 'services', 'clientIds']),
  Note: obj({
    ...record,
    caseId: S('Case id'),
    type: E(choices.noteTypes),
    date: D('Date of the work'),
    minutes: I('Time spent in minutes (0 to 1440)'),
    text: S('What happened'),
    authorId: S('User id'),
  }),
  NoteInput: obj({
    type: E(choices.noteTypes), date: D('Date, not in the future. Defaults to today'), minutes: I('Time spent in minutes (0 to 1440)'), text: S('What happened'),
  }, ['type', 'text']),
  Person: obj({
    ...record, ...personFields, consentDate: D('When the consent answers were recorded'), consentBy: S('Who recorded them (user id)'), addedBy: S('User id'),
  }),
  PersonInput: obj({
    ...personFields,
    confirmMatches: B('Save even though possible duplicates or conflicts of interest were reported (409 possible_matches)'),
  }, ['kind', 'firstName', 'lastName', 'ageCategory']),
  Task: obj({
    ...record,
    ...taskFields,
    done: B('Completed'),
    doneAt: T('When completed'),
    doneBy: S('Who completed it'),
    overdue: B('Not done and the due date has passed'),
    case: obj({
      id: S('Case id'), caseNumber: S('Case number'), heading: S('Heading ("Confidential case" when you cannot open it)'), redacted: B('True for a confidential case you cannot open'),
    }),
    createdBy: S('User id'),
  }),
  TaskInput: obj(taskFields, ['title', 'dueDate']),
  Report: obj({
    ...record, ...reportFields, attachments: A(ref('Attachment')), createdBy: S('User id'),
  }),
  ReportInput: obj(reportFields, ['heading', 'activityType', 'introduction', 'objectives', 'implementation']),
  AttendanceInput: obj({
    rows: A(obj({
      firstName: S('First name'), lastName: S('Last name'), ageCategory: E(choices.ageCategories), age: I('Age'),
      nrc: S('NRC, 123456/78/1'), contact: S('Contact'), disability: E(choices.disability, 'Defaults to "Not Disabled"'), location: S('Village or area (defaults to the venue)'),
    }, ['firstName', 'lastName', 'ageCategory']), 'Up to 200 attendees'),
    consentRecord: E(['', 'yes', 'no'], 'Applies to every row'),
    consentShare: E(['', 'yes', 'no'], 'Applies to every row'),
  }, ['rows']),
  Referral: obj({
    ...record,
    caseId: S('Case id'),
    organizationId: S('Stakeholder organisation id'),
    followUp: E(choices.followUpNeeds),
    reason: S('Why the case is referred'),
    followUps: A(obj({
      id: S('Id'), description: S('What was done'), status: S('Case status set at the follow up'), conductedBy: S('User id'), conductedOn: T('When'),
    })),
    case: obj({
      id: S('Case id'), caseNumber: S('Case number'), heading: S('Heading'), status: S('Status'),
    }),
    redacted: B('True when the referral belongs to a confidential case you cannot open; only basic fields are shown'),
    warnings: A({ type: 'string' }, 'For example clients who have not agreed to their information being shared'),
  }),
  ReferralInput: obj({
    caseId: S('Case to refer'),
    organizationId: S('Stakeholder organisation'),
    followUp: E(choices.followUpNeeds, 'Defaults to "Needs follow up"'),
    reason: S('Why the case is referred'),
    markReferred: B('Set the case status to "Open Referred". Defaults to true'),
  }, ['caseId', 'organizationId']),
  FollowUpInput: obj({
    description: S('What was done during the follow up'),
    status: E(['', ...choices.caseStatuses.filter((s) => s.startsWith('Open'))], 'Also change the case status (to conclude a case, update the case with its outcome)'),
    followUp: E(['', ...choices.followUpNeeds], 'Whether more follow up is needed'),
  }, ['description']),
  Stakeholder: obj({ ...record, ...stakeholderFields, createdBy: S('User id') }),
  StakeholderInput: obj(stakeholderFields, ['name', 'contactPerson', 'phone']),
  Project: obj({ ...record, ...projectFields }),
  ProjectInput: obj(projectFields, ['title', 'startDate', 'endDate']),
  User: obj({
    id: S('User id'),
    ...userFields,
    totpEnabled: B('Uses two-step verification (administrators and the person themselves)'),
    mustChangePassword: B('Has a temporary password'),
    lastLoginAt: T('Last sign-in'),
    lockedUntil: T('Locked after too many wrong passwords until'),
  }, [], 'Colleagues see id, username, fullName, role, office and active; administrators see everything except passwords and secrets'),
  NewUserInput: obj({ ...userFields, password: S('Temporary password, at least 10 characters. They must change it at first sign-in') }, ['username', 'fullName', 'password']),
  UserPatch: obj({
    ...userFields,
    password: S('Set a new temporary password (signs the person out everywhere)'),
    unlock: B('Unlock after too many wrong passwords'),
    resetTwoStep: B('Turn off two-step verification, for a lost phone'),
  }),
  Room: obj({
    ...record, name: S('Topic'), description: S('Description'), caseId: S('Related case'), memberIds: ids('members'), createdBy: S('User id'), lastMessageAt: T('Last message'),
  }),
  RoomInput: obj({ name: S('Topic'), description: S('Description'), caseId: S('Related case (optional)') }, ['name']),
  Message: obj({
    id: S('Id'), roomId: S('Room id'), senderId: S('User id'), senderName: S('Name'), content: S('Text'), createdAt: T('Sent at'), mine: B('Sent by you'),
  }),
  Token: obj({
    id: S('Token id (for revoking; not the token itself)'), kind: E(['session', 'personal']), label: S('Name'), hint: S('Last 4 characters of the token, to recognise it'),
    createdAt: T('Created'), expiresAt: T('Expires'), lastUsedAt: T('Last used'), current: B('The token used for this request'),
  }),
  LoginInput: obj({
    username: S('Username'), password: S('Password'), code: S('Two-step code (6 digits) or a recovery code, when the account uses two-step verification'),
    label: S('Optional name for this sign-in, for example "Field tablet"'),
  }, ['username', 'password']),
  LoginResult: obj({
    token: S('Send as "Authorization: Bearer <token>". Shown only once'),
    tokenType: E(['Bearer']),
    expiresAt: T(`Expiry (${config.api.tokenHours} hours after sign-in)`),
    requiredActions: A(E(['change_password', 'set_up_two_step'])),
    user: ref('User'),
  }),
  Statistics: obj({
    period: obj({ from: D('From'), to: D('To'), office: S('Office filter'), projectId: S('Project filter') }),
    totals: { type: 'object', additionalProperties: { type: ['number', 'null'] }, description: 'opened, closed, openNow, resolvedRate, avgDays, medianDays, served, newClients, referrals, followUps, activities, registeredAttendees, otherParticipants, reach, hoursLogged' },
    openedByType: tally,
    openedByService: tally,
    openedByOffice: tally,
    closedByOutcome: tally,
    servedByAge: tally,
    servedDisabled: I('Clients served with a disability'),
    newByAge: tally,
    heardVia: tally,
    referralsByOrg: tally,
    activitiesByType: tally,
    activitiesByDistrict: tally,
    attendeesByAge: tally,
    attendeesDisabled: I('Registered attendees with a disability'),
    hoursByType: tally,
    hoursByOfficer: tally,
    caseload: tally,
  }),
};

const list = (item) => obj({
  data: A(ref(item)), page: I('Page number'), pageSize: I('Records per page'), total: I('Records matching'), pages: I('Number of pages'),
});
const plainList = (item) => obj({ data: A(ref(item)) });

// ---------- Parameters ----------
const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', description, schema });
const paging = [
  q('page', 'Page number, from 1', { type: 'integer', minimum: 1, default: 1 }),
  q('pageSize', 'Records per page (1 to 100)', { type: 'integer', minimum: 1, maximum: 100, default: 25 }),
];
const sort = (fields) => q('sort', `Sort by ${fields.join(', ')}. Put a minus sign in front for newest or largest first, for example -${fields[0]}`, { type: 'string', enum: fields.flatMap((f) => [f, `-${f}`]) });
const dates = (what) => [q('from', `${what} on or after (YYYY-MM-DD)`, { type: 'string', format: 'date' }), q('to', `${what} on or before (YYYY-MM-DD)`, { type: 'string', format: 'date' })];
const ifMatch = {
  name: 'If-Match', in: 'header', description: 'The etag you read. The change is refused with 412 if someone else changed the record since', schema: { type: 'string' },
};

// ---------- Responses ----------
const errorResponse = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
// Possible on every request that needs a token; the docs page explains these once instead of on every operation.
const COMMON_ERRORS = {
  401: 'Not signed in, or the token has expired or been revoked',
  403: 'Not allowed, for example a confidential case or an administrator-only action',
  429: 'Too many requests',
};

// ---------- Operations ----------
const paths = {};
function op(method, path, tag, summary, o = {}) {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1], in: 'path', required: true, schema: { type: 'string' },
  }));
  const responses = {};
  if (o.status === 204) responses[204] = { description: o.okDescription || 'Done (no content)' };
  else responses[o.status || 200] = o.raw || json(o.ok || { type: 'object' }, o.okDescription || (o.status === 201 ? 'Created' : 'OK'));
  const errors = { ...(o.public ? {} : COMMON_ERRORS), ...(o.errors || {}) };
  for (const [code, text] of Object.entries(errors)) responses[code] = errorResponse(text);
  const operation = {
    tags: [tag],
    summary,
    ...(o.description && { description: o.description }),
    operationId: o.id || `${method}${path.replace(/\{(\w+)\}/g, 'By$1').replace(/[^A-Za-z0-9]+(.)?/g, (m, c) => (c ? c.toUpperCase() : ''))}`,
    parameters: [...pathParams, ...(o.query || []), ...(o.ifMatch ? [ifMatch] : [])],
    ...(o.body && {
      requestBody: {
        required: true,
        content: o.multipart
          ? { 'multipart/form-data': { schema: obj({ files: A({ type: 'string', format: 'binary' }, 'Up to 5 files') }, ['files']) } }
          : { 'application/json': { schema: o.body } },
      },
    }),
    responses,
    ...(o.public ? { security: [] } : {}),
    ...(o.admin && { 'x-admin-only': true }),
  };
  paths[path] = paths[path] || {};
  paths[path][method] = operation;
}

const V = { 422: 'Some fields need attention (see error.fields)' };
const NF = { 404: 'Not found' };
const PRE = { 412: 'Changed by someone else since you read it' };

// Sign-in and your account
op('post', '/auth/login', 'Sign-in', 'Sign in and get a token', {
  public: true, body: ref('LoginInput'), status: 201, ok: ref('LoginResult'),
  description: `Checks the username and password with the same rules as the web login: 5 wrong passwords lock the account for ${config.lockMinutes} minutes and each connection may fail 20 times every 15 minutes. Accounts with two-step verification must also send "code". Tokens last ${config.api.tokenHours} hours.`,
  errors: {
    401: 'Wrong username or password (invalid_credentials), or a two-step code is needed (two_step_required) or wrong (invalid_code)',
    403: 'Two-step verification must be set up in the web app first (two_step_setup_required)',
    423: 'Account locked after too many wrong passwords (account_locked)',
    429: 'Too many sign-in attempts from this connection',
    ...V,
  },
});
op('post', '/auth/logout', 'Sign-in', 'Sign out (revoke the token used for this request)', { status: 204 });
op('get', '/me', 'Your account', 'Who you are signed in as', { ok: obj({ user: ref('User'), token: ref('Token'), requiredActions: A({ type: 'string' }) }) });
op('post', '/me/password', 'Your account', 'Change your password', {
  body: obj({ current: S('Current password'), password: S('New password, at least 10 characters, not containing your username') }, ['current', 'password']),
  ok: obj({ ok: B('Changed'), message: S('Message') }),
  description: 'Your other sessions and API tokens are signed out; the token used for this request keeps working.',
  errors: V,
});
op('get', '/me/tokens', 'Your account', 'Your API tokens', { ok: plainList('Token') });
op('post', '/me/tokens', 'Your account', 'Create a personal access token', {
  body: obj({ label: S('Name, for example "Power BI report"'), days: I(`Days until it expires (1 to ${config.api.personalTokenMaxDays})`), password: S('Your password, to confirm') }, ['label', 'days', 'password']),
  status: 201, ok: obj({ token: S('Shown only once'), tokenType: E(['Bearer']), ...schemas.Token.properties }),
  description: 'For scripts and reports that cannot sign in with a two-step code. Treat it like a password. It stops working when it expires, when you revoke it, or when your sessions are signed out (for example after a password change).',
  errors: V,
});
op('delete', '/me/tokens/{id}', 'Your account', 'Revoke one of your tokens', { status: 204, errors: NF });

// Cases
op('get', '/cases', 'Cases', 'List cases', {
  description: 'Only cases you may open are listed: confidential cases appear only for their officer, the case team and administrators.',
  query: [
    q('status', 'A status, or "open" or "concluded"'), q('office', 'Office'), q('type', 'Type of case'), q('outcome', 'Outcome'),
    q('officer', '"me" or a user id'), q('client', 'Client id'), q('confidential', '"true" for confidential cases only'),
    ...dates('Opened'), q('q', 'Search heading, case number and complaint'), sort(['updatedAt', 'createdAt', 'openedOn', 'caseNumber']), ...paging,
  ],
  ok: list('Case'),
});
op('post', '/cases', 'Cases', 'Open a case', {
  body: ref('CaseInput'), status: 201, ok: ref('Case'), errors: V,
  description: 'The case number (for example KDLA/2026/0001) is given automatically.',
});
op('get', '/cases/{id}', 'Cases', 'Get a case', { ok: ref('Case'), errors: { ...NF, 403: 'Confidential case (confidential)' } });
op('patch', '/cases/{id}', 'Cases', 'Change a case', {
  body: ref('CaseInput'), ok: ref('Case'), ifMatch: true, errors: { ...NF, ...PRE, ...V },
  description: 'Send only the fields you want to change. To conclude a case set a "Concluded" status with an outcome. Only the officer, the person who opened the case or an administrator can change "restricted" and "teamIds". Every change is added to the case history.',
});
op('delete', '/cases/{id}', 'Cases', 'Delete a case with its diary, tasks, referrals and files', { status: 204, admin: true, errors: NF });
op('get', '/cases/{id}/parties', 'Cases', 'Clients and other parties on a case', { ok: obj({ clients: A(ref('Person')), otherParties: A(ref('Person')) }), errors: NF });
op('get', '/cases/{id}/conflicts', 'Cases', 'Conflict of interest alerts for a case', {
  ok: obj({ data: A(obj({ reason: S('Why'), party: { type: 'object' }, match: { type: 'object' } })) }), errors: NF,
});
op('get', '/cases/{id}/notes', 'Case diary', 'Diary entries, newest first', { ok: obj({ data: A(ref('Note')), totalMinutes: I('Time logged') }), errors: NF });
op('post', '/cases/{id}/notes', 'Case diary', 'Add a diary entry', { body: ref('NoteInput'), status: 201, ok: ref('Note'), errors: { ...NF, ...V } });
op('get', '/cases/{id}/notes/{noteId}', 'Case diary', 'Get a diary entry', { ok: ref('Note'), errors: NF });
op('delete', '/cases/{id}/notes/{noteId}', 'Case diary', 'Delete a diary entry (its author or an administrator)', { status: 204, errors: NF });

for (const [kind, tag] of [['cases', 'Case files'], ['reports', 'Report files']]) {
  op('get', `/${kind}/{id}/attachments`, tag, 'List files', { ok: plainList('Attachment'), errors: NF });
  op('post', `/${kind}/{id}/attachments`, tag, 'Upload files', {
    body: true, multipart: true, status: 201, ok: plainList('Attachment'),
    description: `Send multipart/form-data with up to 5 files in a field called "files", each under ${config.storage.maxFileMb} MB: PDF, images, Word, Excel, OpenDocument, text, CSV or zip.`,
    errors: {
      ...NF, 413: 'File too large', 415: 'File type not allowed', ...V,
    },
  });
  op('get', `/${kind}/{id}/attachments/{fileId}`, tag, 'Download a file', {
    raw: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, errors: NF,
  });
  op('delete', `/${kind}/{id}/attachments/{fileId}`, tag, 'Delete a file', { status: 204, errors: NF });
}

// People
op('get', '/people', 'People', 'List clients, other parties and attendees', {
  query: [
    q('kind', 'client, defendant or attendee'), q('ageCategory', 'Girl, Boy, Woman or Man'), q('disability', 'Disabled or Not Disabled'),
    q('projectId', 'Project id'), q('consent', '"missing" for people without recorded consent'), q('q', 'Search name, NRC, contact and file number'),
    sort(['createdAt', 'updatedAt', 'lastName', 'firstName']), ...paging,
  ],
  ok: list('Person'),
});
op('post', '/people', 'People', 'Register a person', {
  body: ref('PersonInput'), status: 201, ok: ref('Person'),
  description: 'Before saving, the system looks for the same name or NRC. If it finds possible duplicates, or a conflict of interest (for example a new client who is already an other party), nothing is saved and you get 409 with the matches. Review them, then send the request again with "confirmMatches": true.',
  errors: { 409: 'Possible duplicates or conflicts of interest (possible_matches)', ...V },
});
op('get', '/people/{id}', 'People', 'Get a person', { ok: ref('Person'), errors: NF });
op('patch', '/people/{id}', 'People', 'Change a person', {
  body: ref('PersonInput'), ok: ref('Person'), ifMatch: true, errors: {
    ...NF, 409: 'Possible duplicates or conflicts of interest (possible_matches)', ...PRE, ...V,
  },
});
op('delete', '/people/{id}', 'People', 'Delete a person (they are removed from cases and reports, which stay)', { status: 204, admin: true, errors: NF });
op('get', '/people/{id}/links', 'People', 'Cases or activity reports linked to a person', { ok: obj({ cases: A({ type: 'object' }), reports: A({ type: 'object' }) }), errors: NF });
op('get', '/people/{id}/personal-data', 'People', 'Everything held about a person (data subject access request)', {
  admin: true, errors: NF, description: 'For requests under the Data Protection Act No. 3 of 2021. The export is recorded in the audit trail.',
});
op('get', '/conflicts', 'People', 'Conflict of interest check by name or NRC', {
  query: [q('name', 'Full or partial name'), q('nrc', 'NRC number')],
  ok: obj({ name: S('Name searched'), nrc: S('NRC searched'), data: A(obj({ person: { type: 'object' }, exactMatch: B('Exact name or NRC match'), cases: A({ type: 'object' }) })) }),
  errors: V,
});

// Tasks
op('get', '/tasks', 'Tasks and hearings', 'List tasks, hearings and deadlines', {
  query: [
    q('who', '"me" (default), "all" or a user id'), q('show', '"open" (default) or "done"'), q('type', 'Type'), q('caseId', 'Case id'),
    ...dates('Due'), ...paging,
  ],
  ok: list('Task'),
  description: 'Open tasks are sorted by due date, earliest first; done tasks newest first. Tasks on confidential cases are hidden unless you can open the case or the task is yours.',
});
op('post', '/tasks', 'Tasks and hearings', 'Add a task, hearing or appointment', { body: ref('TaskInput'), status: 201, ok: ref('Task'), errors: V });
op('get', '/tasks/{id}', 'Tasks and hearings', 'Get a task', { ok: ref('Task'), errors: NF });
op('patch', '/tasks/{id}', 'Tasks and hearings', 'Change a task (the person responsible, its creator or an administrator)', {
  body: ref('TaskInput'), ok: ref('Task'), ifMatch: true, errors: { ...NF, ...PRE, ...V },
});
op('post', '/tasks/{id}/done', 'Tasks and hearings', 'Mark done or reopen', { body: obj({ done: B('true (default) marks it done, false reopens it') }), ok: ref('Task'), errors: NF });
op('delete', '/tasks/{id}', 'Tasks and hearings', 'Delete a task (the person responsible, its creator or an administrator)', { status: 204, errors: NF });
op('get', '/tasks/{id}/calendar.ics', 'Tasks and hearings', 'Calendar file for Outlook or a phone', {
  raw: { description: 'iCalendar file', content: { 'text/calendar': { schema: { type: 'string' } } } }, errors: NF,
});

// Activity reports
op('get', '/reports', 'Activity reports', 'List activity reports', {
  query: [q('district', 'District'), q('activityType', 'Type of activity'), q('projectId', 'Project id'), ...dates('Activity date'), q('q', 'Search heading, introduction, objectives and venue'), sort(['date', 'createdAt', 'updatedAt']), ...paging],
  ok: list('Report'),
});
op('post', '/reports', 'Activity reports', 'Add an activity report', { body: ref('ReportInput'), status: 201, ok: ref('Report'), errors: V });
op('get', '/reports/{id}', 'Activity reports', 'Get a report', { ok: ref('Report'), errors: NF });
op('patch', '/reports/{id}', 'Activity reports', 'Change a report', { body: ref('ReportInput'), ok: ref('Report'), ifMatch: true, errors: { ...NF, ...PRE, ...V } });
op('delete', '/reports/{id}', 'Activity reports', 'Delete a report and its files', { status: 204, admin: true, errors: NF });
op('get', '/reports/{id}/attendees', 'Activity reports', 'Registered attendees with totals', {
  ok: obj({ data: A(ref('Person')), byAgeCategory: tally, withDisability: I('With a disability'), otherParticipants: I('Not registered individually') }), errors: NF,
});
op('post', '/reports/{id}/attendees', 'Activity reports', 'Attendance register: add many attendees at once', {
  body: ref('AttendanceInput'),
  ok: obj({ added: I('New people registered'), linked: I('Already registered (same NRC) and linked'), report: ref('Report') }),
  description: 'Nothing is saved if any row has a problem; error.rowErrors lists them by row number.',
  errors: { ...NF, ...V },
});

// Referrals
op('get', '/referrals', 'Referrals', 'List referrals', {
  query: [q('followUp', '"Needs follow up" or "Does not need follow up"'), q('caseId', 'Case id'), q('organizationId', 'Organisation id'), sort(['createdAt', 'updatedAt']), ...paging],
  ok: list('Referral'),
});
op('post', '/referrals', 'Referrals', 'Refer a case to a partner organisation', {
  body: ref('ReferralInput'), status: 201, ok: ref('Referral'), errors: V,
  description: 'Unless "markReferred" is false the case status becomes "Open Referred". "warnings" lists clients who have not agreed to their information being shared.',
});
op('get', '/referrals/{id}', 'Referrals', 'Get a referral', { ok: ref('Referral'), errors: { ...NF, 403: 'Belongs to a confidential case (confidential)' } });
op('post', '/referrals/{id}/follow-ups', 'Referrals', 'Record a follow up', { body: ref('FollowUpInput'), status: 201, ok: ref('Referral'), errors: { ...NF, ...V } });
op('delete', '/referrals/{id}', 'Referrals', 'Delete a referral', { status: 204, admin: true, errors: NF });

// Stakeholders, projects, staff
op('get', '/stakeholders', 'Stakeholders', 'List partner organisations', { query: [q('q', 'Search name, description, services and contact'), sort(['name', 'createdAt']), ...paging], ok: list('Stakeholder') });
op('post', '/stakeholders', 'Stakeholders', 'Add an organisation', { body: ref('StakeholderInput'), status: 201, ok: ref('Stakeholder'), errors: V });
op('get', '/stakeholders/{id}', 'Stakeholders', 'Get an organisation', { ok: ref('Stakeholder'), errors: NF });
op('patch', '/stakeholders/{id}', 'Stakeholders', 'Change an organisation', { body: ref('StakeholderInput'), ok: ref('Stakeholder'), ifMatch: true, errors: { ...NF, ...PRE, ...V } });
op('delete', '/stakeholders/{id}', 'Stakeholders', 'Delete an organisation without referrals', { status: 204, admin: true, errors: { ...NF, 409: 'Has referrals (in_use)' } });

op('get', '/projects', 'Projects', 'List projects', { ok: plainList('Project') });
op('post', '/projects', 'Projects', 'Add a project', { body: ref('ProjectInput'), status: 201, ok: ref('Project'), admin: true, errors: V });
op('get', '/projects/{id}', 'Projects', 'Get a project', { ok: ref('Project'), errors: NF });
op('patch', '/projects/{id}', 'Projects', 'Change a project', { body: ref('ProjectInput'), ok: ref('Project'), admin: true, ifMatch: true, errors: { ...NF, ...PRE, ...V } });
op('delete', '/projects/{id}', 'Projects', 'Delete a project not used by people or reports', { status: 204, admin: true, errors: { ...NF, 409: 'In use (in_use)' } });

op('get', '/users', 'Staff accounts', 'List staff', { query: [q('active', 'true or false'), q('role', 'officer or admin')], ok: plainList('User') });
op('post', '/users', 'Staff accounts', 'Create a staff account', { body: ref('NewUserInput'), status: 201, ok: ref('User'), admin: true, errors: V });
op('get', '/users/{id}', 'Staff accounts', 'Get a staff account', { ok: ref('User'), errors: NF });
op('patch', '/users/{id}', 'Staff accounts', 'Change a staff account', {
  body: ref('UserPatch'), ok: ref('User'), admin: true, errors: { ...NF, ...V },
  description: 'A new password, a role change, disabling the account or resetting two-step verification signs the person out of every session and token.',
});

// Other
op('get', '/choices', 'Reference', 'Every option list used in forms', { ok: { type: 'object', additionalProperties: A({ type: 'string' }) } });
op('get', '/statistics', 'Reference', 'Statistics for a period, disaggregated for donor reporting', {
  query: [q('from', 'From (YYYY-MM-DD), default 1 January this year', { type: 'string', format: 'date' }), q('to', 'To (YYYY-MM-DD), default today', { type: 'string', format: 'date' }), q('office', 'Office'), q('projectId', 'Project id')],
  ok: ref('Statistics'), errors: V,
});
op('get', '/search', 'Reference', 'Search cases, people, reports and organisations', {
  query: [q('q', 'At least 2 characters')], ok: obj({ term: S('Term'), cases: A({ type: 'object' }), people: A({ type: 'object' }), reports: A({ type: 'object' }), stakeholders: A({ type: 'object' }) }), errors: V,
});

op('get', '/rooms', 'Consultation rooms', 'Rooms you are a member of (administrators see all)', { ok: plainList('Room') });
op('post', '/rooms', 'Consultation rooms', 'Create a room', { body: ref('RoomInput'), status: 201, ok: ref('Room'), errors: V });
op('get', '/rooms/{id}', 'Consultation rooms', 'Get a room', { ok: ref('Room'), errors: NF });
op('delete', '/rooms/{id}', 'Consultation rooms', 'Delete a room and its messages (its creator or an administrator)', { status: 204, errors: NF });
op('get', '/rooms/{id}/messages', 'Consultation rooms', 'Messages, oldest first', {
  query: [q('after', 'Only messages after this time (the createdAt of the newest message you have)'), q('limit', 'Up to 500, default 200', { type: 'integer' })],
  ok: plainList('Message'), errors: NF,
});
op('post', '/rooms/{id}/messages', 'Consultation rooms', 'Send a message', { body: obj({ content: S('Text, up to 4000 characters') }, ['content']), status: 201, ok: ref('Message'), errors: { ...NF, ...V } });
op('post', '/rooms/{id}/members', 'Consultation rooms', 'Add a colleague to a room', { body: obj({ userId: S('User id') }, ['userId']), ok: ref('Room'), errors: { ...NF, ...V } });
op('post', '/rooms/{id}/leave', 'Consultation rooms', 'Leave a room', { status: 204, errors: NF });

op('get', '/audit', 'Administration', 'Audit trail', {
  admin: true,
  query: [q('action', 'login, login_failed, logout, create, update, delete, view, download, export or security'), q('userId', 'User id'), q('entity', 'Record type, for example cases'), q('entityId', 'Record id'), ...dates('Date'), ...paging],
  ok: obj({ data: A({ type: 'object' }), page: I('Page'), pageSize: I('Page size'), total: I('Total'), pages: I('Pages') }),
});
op('get', '/export', 'Administration', 'Export every record as JSON (backups and data portability)', {
  admin: true, description: 'Passwords, two-step secrets and API tokens are left out. The export is recorded in the audit trail.',
});

const TAG_TEXT = {
  'Sign-in': 'Get a token, then send it with every request as "Authorization: Bearer <token>".',
  'Your account': 'Your password and API tokens.',
  Cases: 'Case files. Confidential cases follow the same rules as in the web app.',
  'Case diary': 'Meetings, calls and other work on a case, with time spent.',
  'Case files': 'Documents attached to a case.',
  People: 'Clients, other parties (defendants) and activity attendees: the direct beneficiaries.',
  'Tasks and hearings': 'Tasks, court hearings, mediation sessions and deadlines.',
  'Activity reports': 'Community meetings, trainings, radio programmes and other activities, with attendance registers.',
  'Report files': 'Documents attached to an activity report.',
  Referrals: 'Cases referred to partner organisations, and their follow ups.',
  Stakeholders: 'Partner organisations that cases can be referred to.',
  Projects: 'Donor projects that people and reports are linked to.',
  'Staff accounts': 'Colleagues and their access.',
  Reference: 'Option lists, statistics and search.',
  'Consultation rooms': 'Discussions between staff about a case or a question.',
  Administration: 'Administrators only.',
};

function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: `${config.appName} API`,
      version: pkg.version,
      description: `JSON API for ${config.orgFullName}. It follows the same rules as the web app: confidential cases, `
        + 'administrator-only actions, conflict of interest checks and the audit trail all apply. Dates are YYYY-MM-DD; '
        + 'times are ISO 8601 in UTC. Lists are paged ("page", "pageSize"; at most 100 per page).',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: Object.entries(TAG_TEXT).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A token from POST /auth/login or from Account > API access in the web app' },
      },
      schemas,
    },
  };
}

module.exports = { buildSpec, COMMON_ERRORS };
