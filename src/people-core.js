'use strict';
// Shared rules for registering clients, other parties and activity attendees.
const choices = require('./choices');
const { str, intOrNull, today } = require('./helpers');
const { nameKey } = require('./conflicts');

/** Zambian NRC numbers are written 123456/78/1. Accept 9 plain digits too. */
function normaliseNrc(raw) {
  const s = str(raw, 20).replace(/\s+/g, '');
  const digits = s.replace(/\D/g, '');
  if (/^\d{9}$/.test(digits) && /^[\d/]+$/.test(s)) return `${digits.slice(0, 6)}/${digits.slice(6, 8)}/${digits.slice(8)}`;
  return s;
}

const YES_NO = ['yes', 'no'];

function readPerson(body, kind) {
  const v = {
    firstName: str(body.firstName, 128),
    lastName: str(body.lastName, 128),
    nrc: normaliseNrc(body.nrc),
    contact: str(body.contact, 200),
    age: intOrNull(body.age),
    ageCategory: str(body.ageCategory),
    civilStatus: str(body.civilStatus),
    disability: str(body.disability),
    projectId: str(body.projectId),
    location: str(body.location, 200),
  };
  if (kind === 'client') {
    v.caseNumber = str(body.caseNumber, 50);
    v.referralSource = str(body.referralSource);
  }
  if (kind === 'defendant') v.versusClientId = str(body.versusClientId);
  if (kind === 'attendee') v.activity = str(body.activity);
  if (kind !== 'defendant') {
    const yesNo = (x) => (YES_NO.includes(String(x || '').toLowerCase()) ? String(x).toLowerCase() : '');
    v.consentRecord = yesNo(body.consentRecord);
    v.consentShare = yesNo(body.consentShare);
  }
  v.nameKey = nameKey(v.firstName, v.lastName);
  return v;
}

/** Girl and Boy are under 18; Woman and Man are 18 or over. */
function ageCategoryProblem(age, category) {
  if (age === null || age === undefined || Number.isNaN(age) || !category) return null;
  if (['Girl', 'Boy'].includes(category) && age >= 18) return `${category} is for people under 18. Choose ${category === 'Girl' ? 'Woman' : 'Man'} or check the age.`;
  if (['Woman', 'Man'].includes(category) && age < 18) return `${category} is for people aged 18 or over. Choose ${category === 'Woman' ? 'Girl' : 'Boy'} or check the age.`;
  return null;
}

async function validatePerson(db, v, kind, selfId) {
  const e = {};
  if (!v.firstName) e.firstName = 'Enter a first name.';
  if (!v.lastName) e.lastName = 'Enter a last name.';
  if (v.nrc && !/^\d{6}\/\d{2}\/\d$/.test(v.nrc)) e.nrc = 'NRC must look like 123456/78/1.';
  if (Number.isNaN(v.age) || (v.age !== null && (v.age < 0 || v.age > 120))) e.age = 'Enter an age between 0 and 120.';
  if (!choices.ageCategories.includes(v.ageCategory)) e.ageCategory = 'Select an age category.';
  else {
    const problem = ageCategoryProblem(v.age, v.ageCategory);
    if (problem) e.ageCategory = problem;
  }
  if (v.civilStatus && !choices.civilStatuses.includes(v.civilStatus)) e.civilStatus = 'Select a valid civil status.';
  if (v.disability && !choices.disability.includes(v.disability)) e.disability = 'Select a valid option.';
  if (v.projectId && !(await db.get('projects', v.projectId))) e.projectId = 'Select a valid project.';
  if (v.nrc) {
    const dup = await db.find('people', { where: { kind, nrc: v.nrc }, fields: ['id'] });
    if (dup.some((d) => d.id !== selfId)) e.nrc = `Another ${kind === 'defendant' ? 'other party' : kind} already has this NRC number.`;
  }
  if (kind === 'client') {
    if (v.referralSource && !choices.activities.includes(v.referralSource)) e.referralSource = 'Select a valid option.';
    if (v.caseNumber) {
      const dup = await db.find('people', { where: { kind, caseNumber: v.caseNumber }, fields: ['id'] });
      if (dup.some((d) => d.id !== selfId)) e.caseNumber = 'Another client already has this file number.';
    }
  }
  if (kind === 'defendant' && v.versusClientId) {
    const c = await db.get('people', v.versusClientId);
    if (!c || c.kind !== 'client') e.versusClientId = 'Select a valid client.';
  }
  if (kind === 'attendee' && v.activity && !choices.activities.includes(v.activity)) e.activity = 'Select a valid activity.';
  return e;
}

/** Consent bookkeeping: remember when and by whom consent answers were recorded or changed. */
function withConsentStamp(v, previous, user) {
  if (!('consentRecord' in v)) return v;
  const changed = !previous || previous.consentRecord !== v.consentRecord || previous.consentShare !== v.consentShare;
  if (changed && (v.consentRecord || v.consentShare)) return { ...v, consentDate: today(), consentBy: user.id };
  if (!v.consentRecord && !v.consentShare) return { ...v, consentDate: '', consentBy: '' };
  return { ...v, consentDate: previous.consentDate || '', consentBy: previous.consentBy || '' };
}

module.exports = {
  normaliseNrc, readPerson, validatePerson, ageCategoryProblem, withConsentStamp,
};
