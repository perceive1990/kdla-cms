'use strict';
// Statistics for a chosen period, disaggregated the way donors usually ask for
// (age category and sex, disability, case type, outcome, office). Shared by the web page and the API.
const choices = require('../choices');
const {
  tally, mapByIds, today, isRealDate, daysBetween,
} = require('../helpers');

function period(params = {}) {
  const t = today();
  const from = isRealDate(params.from) ? params.from : `${t.slice(0, 4)}-01-01`;
  const to = isRealDate(params.to) ? params.to : t;
  const office = choices.offices.includes(params.office) ? params.office : '';
  const projectId = params.projectId ? String(params.projectId).slice(0, 60) : '';
  return { from, to, office, projectId };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function compute(db, { from, to, office, projectId }) {
  const caseFields = ['id', 'status', 'caseTypes', 'services', 'office', 'openedOn', 'closedOn', 'outcome', 'officerId', 'clientIds'];
  const inOffice = office ? { office } : {};
  const toTs = `${to}T23:59:59.999Z`;
  const [opened, closed, openNow, newClients, referrals, reports, notes, users] = await Promise.all([
    db.find('cases', { where: { ...inOffice, openedOn: { $gte: from, $lte: to } }, fields: caseFields }),
    db.find('cases', { where: { ...inOffice, closedOn: { $gte: from, $lte: to } }, fields: caseFields }),
    db.find('cases', { where: { ...inOffice, status: { $in: choices.caseStatuses.filter((s) => s.startsWith('Open')) } }, fields: ['id', 'officerId', 'openedOn'] }),
    db.find('people', { where: { kind: 'client', createdAt: { $gte: from, $lte: toTs }, ...(projectId ? { projectId } : {}) }, fields: ['id', 'ageCategory', 'disability', 'referralSource'] }),
    db.find('referrals', { where: { createdAt: { $gte: from, $lte: toTs } }, fields: ['id', 'organizationId', 'followUps', 'caseId'] }),
    db.find('reports', { where: { date: { $gte: from, $lte: to }, ...(projectId ? { projectId } : {}) }, fields: ['id', 'activityType', 'attendeeIds', 'otherParticipants', 'district'] }),
    db.find('caseNotes', { where: { date: { $gte: from, $lte: to } }, fields: ['id', 'type', 'minutes', 'authorId'] }),
    db.find('users', { fields: ['id', 'fullName', 'username'] }),
  ]);
  const userName = Object.fromEntries(users.map((u) => [u.id, u.fullName || u.username]));

  // Clients served = clients on cases opened in the period.
  const servedMap = await mapByIds(db, 'people', opened.flatMap((c) => c.clientIds || []));
  let served = Object.values(servedMap);
  if (projectId) served = served.filter((p) => p.projectId === projectId);

  const orgs = await mapByIds(db, 'stakeholders', referrals.map((r) => r.organizationId));
  const attendeeMap = await mapByIds(db, 'people', reports.flatMap((r) => r.attendeeIds || []));
  const attendees = Object.values(attendeeMap);
  const otherParticipants = reports.reduce((s, r) => s + (r.otherParticipants || 0), 0);

  const durations = closed.map((c) => daysBetween(c.openedOn, c.closedOn)).filter((d) => d !== null && d >= 0);
  const resolved = closed.filter((c) => String(c.outcome || '').startsWith('Resolved') || String(c.outcome || '').includes('in favour'));

  const minutesBy = (key) => {
    const out = {};
    for (const n of notes) out[key(n)] = (out[key(n)] || 0) + (n.minutes || 0);
    return Object.entries(out).map(([label, mins]) => ({ label, count: Math.round((mins / 60) * 10) / 10 }))
      .sort((a, b) => b.count - a.count);
  };

  const caseload = tally(openNow.map((c) => ({ officer: userName[c.officerId] || 'Unassigned' })), 'officer');

  return {
    totals: {
      opened: opened.length,
      closed: closed.length,
      openNow: openNow.length,
      resolvedRate: closed.length ? Math.round((resolved.length / closed.length) * 100) : null,
      avgDays: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      medianDays: median(durations),
      served: served.length,
      newClients: newClients.length,
      referrals: referrals.length,
      followUps: referrals.reduce((s, r) => s + (r.followUps || []).length, 0),
      activities: reports.length,
      registeredAttendees: attendees.length,
      otherParticipants,
      reach: attendees.length + otherParticipants,
      hoursLogged: Math.round((notes.reduce((s, n) => s + (n.minutes || 0), 0) / 60) * 10) / 10,
    },
    openedByType: tally(opened, 'caseTypes', choices.caseTypes),
    openedByService: tally(opened, 'services', choices.legalServices),
    openedByOffice: tally(opened, 'office', choices.offices),
    closedByOutcome: tally(closed, 'outcome', choices.caseOutcomes),
    servedByAge: tally(served, 'ageCategory', choices.ageCategories),
    servedDisabled: served.filter((p) => p.disability === 'Disabled').length,
    newByAge: tally(newClients, 'ageCategory', choices.ageCategories),
    heardVia: tally(newClients, 'referralSource', choices.activities),
    referralsByOrg: tally(referrals.map((r) => ({ org: orgs[r.organizationId] ? orgs[r.organizationId].name : 'Organisation removed' })), 'org'),
    activitiesByType: tally(reports, 'activityType', choices.activities),
    activitiesByDistrict: tally(reports, 'district', choices.districts),
    attendeesByAge: tally(attendees, 'ageCategory', choices.ageCategories),
    attendeesDisabled: attendees.filter((p) => p.disability === 'Disabled').length,
    hoursByType: minutesBy((n) => n.type),
    hoursByOfficer: minutesBy((n) => userName[n.authorId] || 'Former user'),
    caseload,
  };
}

/** Flat rows (section, item, value) for CSV export. */
function statsRows(p, s) {
  const rows = [];
  const add = (section, list) => list.forEach((x) => rows.push({ section, item: x.label, value: x.count }));
  rows.push({ section: 'Period', item: `${p.from} to ${p.to}${p.office ? ` · ${p.office}` : ''}`, value: '' });
  for (const [k, v] of Object.entries(s.totals)) rows.push({ section: 'Totals', item: k, value: v === null ? '' : v });
  add('Cases opened by type', s.openedByType);
  add('Cases opened by service', s.openedByService);
  add('Cases opened by office', s.openedByOffice);
  add('Cases concluded by outcome', s.closedByOutcome);
  add('Clients served by age category', s.servedByAge);
  rows.push({ section: 'Clients served', item: 'With a disability', value: s.servedDisabled });
  add('New clients by age category', s.newByAge);
  add('New clients heard about KDLA through', s.heardVia);
  add('Referrals by organisation', s.referralsByOrg);
  add('Activities by type', s.activitiesByType);
  add('Activities by district', s.activitiesByDistrict);
  add('Registered attendees by age category', s.attendeesByAge);
  rows.push({ section: 'Registered attendees', item: 'With a disability', value: s.attendeesDisabled });
  add('Hours logged by type', s.hoursByType);
  add('Hours logged by officer', s.hoursByOfficer);
  add('Open caseload by officer', s.caseload);
  return rows;
}

module.exports = { period, compute, statsRows };
