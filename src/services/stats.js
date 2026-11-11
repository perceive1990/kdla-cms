'use strict';
// Statistics for a chosen period, disaggregated the way donors usually ask for
// (age category and sex, disability, case type, outcome, office). Shared by the web page and the API.
const choices = require('../choices');
const { counts: attendanceCounts } = require('../attendance-status');
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
    db.find('reports', { where: { date: { $gte: from, $lte: to }, ...(projectId ? { projectId } : {}) }, fields: ['id', 'activityType', 'attendeeIds', 'otherParticipants', 'district', 'attendanceStatus'] }),
    db.find('caseNotes', { where: { date: { $gte: from, $lte: to } }, fields: ['id', 'type', 'minutes', 'authorId'] }),
    db.find('users', { fields: ['id', 'fullName', 'username'] }),
  ]);
  const userName = Object.fromEntries(users.map((u) => [u.id, u.fullName || u.username]));

  // Clients served = clients on cases opened in the period.
  const servedMap = await mapByIds(db, 'people', opened.flatMap((c) => c.clientIds || []));
  let served = Object.values(servedMap);
  if (projectId) served = served.filter((p) => p.projectId === projectId);

  const orgs = await mapByIds(db, 'stakeholders', referrals.map((r) => r.organizationId));
  // People reached count approved attendance only; activities count every report.
  const approved = reports.filter(attendanceCounts);
  const attendeeMap = await mapByIds(db, 'people', approved.flatMap((r) => r.attendeeIds || []));
  const attendees = Object.values(attendeeMap);
  const otherParticipants = approved.reduce((s, r) => s + (r.otherParticipants || 0), 0);

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

// ---------- Beneficiary statistics: everyone registered, by type, age and sex, disability and more ----------
const BEN_KINDS = { client: 'Clients', defendant: 'Other parties', attendee: 'Activity attendees' };
const WOMEN = ['Woman', 'Girl'];
const CHILDREN = ['Girl', 'Boy'];

/** Filters for the beneficiary statistics: all time unless a period is chosen. */
function benPeriod(params = {}) {
  const from = isRealDate(params.from) ? params.from : '';
  const to = isRealDate(params.to) ? params.to : '';
  const kind = Object.keys(BEN_KINDS).includes(params.kind) ? params.kind : '';
  const projectId = params.projectId ? String(params.projectId).slice(0, 60) : '';
  const community = params.community ? String(params.community).trim().slice(0, 200) : '';
  return {
    from, to, kind, projectId, community,
  };
}

async function beneficiaries(db, {
  from = '', to = '', kind = '', projectId = '', community = '', communityValues = null,
} = {}) {
  const where = {};
  if (community) where.location = { $in: communityValues && communityValues.length ? communityValues : ['\u0000none'] };
  if (kind) where.kind = kind;
  if (projectId) where.projectId = projectId;
  if (from || to) where.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: `${to}T23:59:59.999Z` } : {}) };
  const people = await db.find('people', {
    where, fields: ['id', 'kind', 'ageCategory', 'disability', 'civilStatus', 'location', 'projectId', 'referralSource', 'createdAt', 'consentRecord'],
  });
  const projects = await mapByIds(db, 'projects', people.map((p) => p.projectId));
  const ages = [...choices.ageCategories, 'Not recorded'];
  const share = (n) => (people.length ? Math.round((n / people.length) * 100) : null);
  const count = (fn) => people.filter(fn).length;

  // The main table: each type of beneficiary by age category and sex, with totals.
  const kinds = kind ? [kind] : Object.keys(BEN_KINDS);
  const matrix = kinds.map((k) => {
    const rows = people.filter((p) => p.kind === k);
    const cells = Object.fromEntries(ages.map((a) => [a, rows.filter((p) => (p.ageCategory || 'Not recorded') === a).length]));
    return {
      kind: k, label: BEN_KINDS[k], cells, total: rows.length, disabled: rows.filter((p) => p.disability === 'Disabled').length,
    };
  });
  const totalsRow = {
    label: 'All beneficiaries',
    cells: Object.fromEntries(ages.map((a) => [a, matrix.reduce((s, m) => s + m.cells[a], 0)])),
    total: people.length,
    disabled: count((p) => p.disability === 'Disabled'),
  };

  // Registrations each month (or each year over long periods).
  const dates = people.map((p) => String(p.createdAt || '').slice(0, 10)).filter(Boolean).sort();
  let timeline = [];
  if (dates.length) {
    const first = from || dates[0];
    const last = to || dates[dates.length - 1];
    const months = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    if (months <= 24) {
      const out = new Map();
      for (let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7)); y * 12 + m <= Number(last.slice(0, 4)) * 12 + Number(last.slice(5, 7)); m += 1) {
        if (m > 12) { m = 1; y += 1; }
        out.set(`${y}-${String(m).padStart(2, '0')}`, 0);
      }
      for (const d of dates) out.set(d.slice(0, 7), (out.get(d.slice(0, 7)) || 0) + 1);
      const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      timeline = [...out].map(([k, n], i) => ({ label: `${names[Number(k.slice(5, 7)) - 1]}${i === 0 || k.slice(5, 7) === '01' ? ` ${k.slice(0, 4)}` : ''}`, count: n }));
    } else {
      const out = new Map();
      for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y += 1) out.set(String(y), 0);
      for (const d of dates) out.set(d.slice(0, 4), (out.get(d.slice(0, 4)) || 0) + 1);
      timeline = [...out].map(([label, n]) => ({ label, count: n }));
    }
  }

  const clients = people.filter((p) => p.kind === 'client');
  return {
    total: people.length,
    byKind: matrix.map((m) => ({ label: m.label, count: m.total })),
    ages,
    matrix,
    totalsRow,
    women: count((p) => WOMEN.includes(p.ageCategory)),
    men: count((p) => ['Man', 'Boy'].includes(p.ageCategory)),
    children: count((p) => CHILDREN.includes(p.ageCategory)),
    disabled: totalsRow.disabled,
    ageRecorded: count((p) => p.ageCategory),
    womenPct: share(count((p) => WOMEN.includes(p.ageCategory))),
    childrenPct: share(count((p) => CHILDREN.includes(p.ageCategory))),
    disabledPct: share(totalsRow.disabled),
    byAge: tally(people, 'ageCategory', choices.ageCategories),
    byDisability: tally(people, 'disability', choices.disability),
    byCivil: tally(people, 'civilStatus', choices.civilStatuses),
    byPlace: tally(people.map((p) => ({ place: String(p.location || '').trim() })), 'place').sort((a, b) => b.count - a.count),
    byProject: tally(people.map((p) => ({ project: projects[p.projectId] ? projects[p.projectId].title : '' })), 'project').sort((a, b) => b.count - a.count),
    heardVia: tally(clients, 'referralSource', choices.activities).sort((a, b) => b.count - a.count),
    clients: clients.length,
    noConsent: count((p) => !p.consentRecord || p.consentRecord === 'no'),
    timeline,
    timelineYearly: timeline.length && /^\d{4}$/.test(timeline[0].label),
  };
}

/** Flat rows (section, item, value) of the beneficiary statistics, for CSV export. */
function beneficiaryRows(p, b) {
  const rows = [
    { section: 'Filters', item: 'Registered from', value: p.from || 'the start' },
    { section: 'Filters', item: 'Registered to', value: p.to || 'today' },
    { section: 'Filters', item: 'Community', value: p.community || 'all' },
    { section: 'Totals', item: 'Beneficiaries', value: b.total },
    { section: 'Totals', item: 'Women and girls (%)', value: b.womenPct ?? '' },
    { section: 'Totals', item: 'Children (%)', value: b.childrenPct ?? '' },
    { section: 'Totals', item: 'Persons with disabilities (%)', value: b.disabledPct ?? '' },
  ];
  for (const m of [...b.matrix, b.totalsRow]) {
    for (const a of b.ages) rows.push({ section: `${m.label} by age and sex`, item: a, value: m.cells[a] });
    rows.push({ section: `${m.label} by age and sex`, item: 'Total', value: m.total });
    rows.push({ section: `${m.label} by age and sex`, item: 'Persons with disabilities', value: m.disabled });
  }
  const add = (section, list) => list.forEach((x) => rows.push({ section, item: x.label, value: x.count }));
  add('Civil status', b.byCivil);
  add('Village or area', b.byPlace);
  add('Project', b.byProject);
  add('Clients: heard about KDLA through', b.heardVia);
  add(b.timelineYearly ? 'Registered each year' : 'Registered each month', b.timeline);
  return rows;
}

module.exports = {
  period, compute, statsRows, BEN_KINDS, benPeriod, beneficiaries, beneficiaryRows,
};
