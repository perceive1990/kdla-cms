'use strict';
// Fills the database with fictional demo records so you can try the system.
// Usage: npm run seed-demo   (refuses to run if cases already exist)
const { getDb } = require('../src/db');
const { createUser } = require('./lib');
const { newId, today } = require('../src/helpers');
const { nameKey } = require('../src/conflicts');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

async function main() {
  const db = getDb();
  await db.init();
  if ((await db.count('cases', {})) > 0) {
    console.log('Cases already exist; demo data not added.');
    return;
  }
  let officers = await db.find('users', { where: { role: 'officer' } });
  if (!officers.length) {
    officers = [
      await createUser(db, { username: 'demo.paralegal', password: 'demo-password-1', fullName: 'Demo Paralegal', category: 'Paralegal', office: 'Fisenge Office' }),
      await createUser(db, { username: 'demo.lawyer', password: 'demo-password-2', fullName: 'Demo Lawyer', category: 'Lawyer', office: 'Kitwe Main Office' }),
    ];
  }
  const [o1, o2 = o1] = officers;
  const project = await db.create('projects', {
    id: newId(), title: 'Demo Access to Justice Project', donor: 'Demo donor', description: 'Fictional demo project',
    startDate: `${today().slice(0, 4)}-01-01`, endDate: `${Number(today().slice(0, 4)) + 1}-12-31`, budget: 100000, currency: 'ZMW',
    createdAt: iso(300), updatedAt: iso(300),
  });
  const person = (kind, firstName, lastName, ageCategory, extra = {}, d = 30) => db.create('people', {
    id: newId(), kind, firstName, lastName, nameKey: nameKey(firstName, lastName), ageCategory, nrc: '', contact: '', age: null,
    civilStatus: '', disability: 'Not Disabled', projectId: project.id, location: 'Demo village',
    consentRecord: kind === 'defendant' ? undefined : 'yes', consentShare: kind === 'defendant' ? undefined : 'yes', consentDate: today(),
    addedBy: o1.id, createdAt: iso(d), updatedAt: iso(d), ...extra,
  });
  const c1 = await person('client', 'Demo', 'Client One', 'Woman', { caseNumber: 'DEMO-01', referralSource: 'Community Meeting', disability: 'Disabled' }, 40);
  const c2 = await person('client', 'Demo', 'Client Two', 'Man', { referralSource: 'Radio or TV Program', consentShare: '' }, 20);
  const c3 = await person('client', 'Demo', 'Client Three', 'Girl', { age: 16 }, 5);
  const c4 = await person('client', 'Code', 'Name B', 'Woman', {}, 3);
  const d1 = await person('defendant', 'Demo', 'Other Party', 'Man', { versusClientId: c1.id }, 40);
  const a1 = await person('attendee', 'Demo', 'Attendee One', 'Woman', { activity: 'Community Meeting' }, 10);
  const a2 = await person('attendee', 'Demo', 'Attendee Two', 'Boy', { activity: 'Community Meeting', age: 14 }, 10);

  const year = today().slice(0, 4);
  const mk = async (heading, clientIds, defendantIds, caseTypes, services, status, office, officer, d, extra = {}) => {
    const seq = await db.nextSequence(`case-${year}`);
    return db.create('cases', {
      id: newId(), caseNumber: `KDLA/${year}/${String(seq).padStart(4, '0')}`, heading, clientIds, defendantIds, caseTypes, services,
      complaint: 'Fictional complaint for demonstration.', defence: '', actionTaken: '', status, office, officerId: officer.id,
      openedOn: iso(d).slice(0, 10), closedOn: '', outcome: '', outcomeNotes: '', restricted: false, teamIds: [],
      attachments: [], history: [{ at: iso(d), by: officer.id, action: 'Case opened', status }],
      createdBy: officer.id, createdAt: iso(d), updatedAt: iso(Math.max(d - 2, 0)), ...extra,
    });
  };
  const k1 = await mk('Demo Client One vs Demo Other Party', [c1.id], [d1.id], ['Land and Property'], ['Legal Advice', 'Mediation'], 'Open Active Case', 'Fisenge Office', o1, 40);
  await mk('Demo Client Two employment dispute', [c2.id], [], ['Labour and Employment'], ['Legal Information', 'Referral'], 'Open Referred', 'Kitwe Main Office', o2, 20);
  await mk('Demo Client Three inheritance', [c3.id], [], ['Marriage and Family', 'Land and Property'], ['Accompaniment'], 'Concluded Closed Case', 'Kakolo Office', o1, 25, {
    closedOn: iso(5).slice(0, 10), outcome: 'Resolved by traditional authority', outcomeNotes: 'Fictional: share of the estate agreed before the headman.',
  });
  await mk('Confidential demo matter', [c4.id], [], ['Gender-Based Violence (GBV) related'], ['Legal Advice'], 'Open Active Case', 'Kitwe Main Office', o2, 3, {
    restricted: true, complaint: 'Fictional confidential details.',
  });

  await db.create('caseNotes', {
    id: newId(), caseId: k1.id, type: 'Mediation session', date: iso(7).slice(0, 10), minutes: 90,
    text: 'Fictional: met both parties with the headman; agreed to measure the boundary.', authorId: o1.id, createdAt: iso(7),
  });
  await db.create('caseNotes', {
    id: newId(), caseId: k1.id, type: 'Phone call', date: iso(2).slice(0, 10), minutes: 15,
    text: 'Fictional: client confirmed she can attend on Friday.', authorId: o1.id, createdAt: iso(2),
  });
  const task = (title, type, dueDate, assignee, caseId, extra = {}) => db.create('tasks', {
    id: newId(), title, type, dueDate, dueTime: '', location: '', assigneeId: assignee.id, caseId: caseId || '', notes: '',
    done: false, createdBy: assignee.id, createdAt: iso(1), updatedAt: iso(1), ...extra,
  });
  await task('Boundary measurement with the headman', 'Mediation session', today(3), o1, k1.id, { dueTime: '10:00', location: 'Fisenge' });
  await task('Submit monthly report to the programme officer', 'Deadline', today(-1), o1, '');
  await task('Hearing at Kitwe Local Court', 'Court hearing', today(6), o2, k1.id, { dueTime: '09:00', location: 'Kitwe Local Court' });

  const org = await db.create('stakeholders', {
    id: newId(), name: 'Demo Partner Organisation', description: 'Fictional partner', services: 'Court representation', address: 'Demo address',
    contactPerson: 'Demo Contact', phone: '0000 000000', email: '', createdAt: iso(50), updatedAt: iso(50),
  });
  await db.create('referrals', {
    id: newId(), caseId: k1.id, organizationId: org.id, followUp: 'Needs follow up', reason: 'Needs court representation',
    followUps: [], createdBy: o1.id, createdAt: iso(3), updatedAt: iso(3),
  });
  await db.create('reports', {
    id: newId(), activityType: 'Community Meeting', heading: 'Demo community meeting on land rights', activityNumber: 1,
    date: iso(10).slice(0, 10), district: 'Kitwe District', location: 'Demo community hall', projectId: project.id,
    introduction: 'Fictional introduction.', objectives: 'Fictional objectives.', implementation: 'Fictional implementation.',
    immediateResults: '', challenges: '', recommendations: '', attendeeIds: [a1.id, a2.id], otherParticipants: 25,
    compiledById: o1.id, attachments: [], createdBy: o1.id, createdAt: iso(10), updatedAt: iso(10),
  });
  console.log('Demo data added. Demo officer logins: demo.paralegal / demo-password-1, demo.lawyer / demo-password-2');
}

main().catch((e) => { console.error(e); process.exit(1); });
