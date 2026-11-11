'use strict';
// Monitoring and evaluation: each project's logframe, the results chain of its Theory of Change.
// Levels: overall objective > intermediate objectives > outputs > activities. Results have indicators
// with a baseline, a target and a means of verification. Planned activities in work plans link to an
// output or an activity of the logframe, so every activity report linked to them counts towards the
// results above it. Indicator values are recorded by staff, or worked out from the linked reports or
// from the case records of the project period.
//
// Who may do what: administrators set up and change the logframe; everyone records indicator values.
// One logframe per project; its id is the project id.
const { audit } = require('../audit');
const { counts: attendanceCounts } = require('../attendance-status');
const { isAdmin } = require('../access');
const { compute } = require('./stats');
const {
  newId, now, str, isRealDate, today, mapByIds, daysBetween,
} = require('../helpers');
const { HttpError, notFound, forbidden } = require('./errors');
const { saveLatest } = require('./versioned');

const LEVELS = ['objective', 'outcome', 'output', 'activity'];
const PARENT_LEVEL = { objective: null, outcome: 'objective', output: 'outcome', activity: 'output' };
const CHILD_LEVEL = { objective: 'outcome', outcome: 'output', output: 'activity', activity: null };
const DEFAULT_NAMES = {
  objective: 'Overall objective', outcome: 'Intermediate objective', output: 'Output', activity: 'Activity',
};
const UNITS = ['number', 'percent'];
const DONE = ['Completed', 'Cancelled'];

/**
 * Where an indicator's value comes from. "result" sources count the activity reports linked, through
 * work plans, to the result and everything under it; "project" sources use the case records of the
 * project period. `short` is the name used in spreadsheets (import and export).
 */
const SOURCES = {
  manual: { short: 'Recorded by staff', label: 'Recorded by staff', unit: null, group: 'Recorded' },
  reports: { short: 'Activities held', label: 'Activities held (linked activity reports)', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  reach: { short: 'People reached', label: 'People reached (different registered attendees plus head counts)', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  attendees: { short: 'Registered attendees', label: 'Registered attendees (different people)', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  women: { short: 'Women and girls', label: 'Women and girls among registered attendees', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  children: { short: 'Children', label: 'Children (girls and boys) among registered attendees', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  disabled: { short: 'Persons with disabilities', label: 'Persons with disabilities among registered attendees', unit: 'number', scope: 'result', group: 'From linked activity reports' },
  womenPct: { short: 'Women and girls (%)', label: 'Share of women and girls among registered attendees', unit: 'percent', scope: 'result', group: 'From linked activity reports' },
  childrenPct: { short: 'Children (%)', label: 'Share of children among registered attendees', unit: 'percent', scope: 'result', group: 'From linked activity reports' },
  disabledPct: { short: 'Persons with disabilities (%)', label: 'Share of persons with disabilities among registered attendees', unit: 'percent', scope: 'result', group: 'From linked activity reports' },
  casesOpened: { short: 'Cases opened', label: 'Cases opened in the project period', unit: 'number', scope: 'project', group: 'From case records in the project period' },
  clientsServed: { short: 'Clients served', label: 'Clients served in the project period (registered under this project)', unit: 'number', scope: 'project', group: 'From case records in the project period' },
  referrals: { short: 'Referrals made', label: 'Referrals made in the project period', unit: 'number', scope: 'project', group: 'From case records in the project period' },
};

const invalid = (fields) => new HttpError(422, 'validation_failed', Object.values(fields)[0], { fields });
const names = (fw) => ({ ...DEFAULT_NAMES, ...((fw && fw.names) || {}) });

function numOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

// ---------- The logframe ----------
async function getFramework(db, projectId) {
  return /^[\w-]{1,60}$/.test(String(projectId || '')) ? db.get('logframes', String(projectId)) : null;
}

async function mustFramework(db, projectId) {
  const fw = await getFramework(db, projectId);
  if (!fw) throw notFound('Logframe');
  return fw;
}

const canChange = (user) => isAdmin(user);
function mustAdmin(user) {
  if (!canChange(user)) throw forbidden('Only an administrator can change the logframe.');
}

const saveFramework = (db, fw, change, { ifMatch } = {}) => saveLatest(db, 'logframes', fw, change, { ifMatch, reload: () => mustFramework(db, fw.id) });

async function createFramework(req, project) {
  mustAdmin(req.user);
  const existing = await getFramework(req.db, project.id);
  if (existing) return existing;
  const doc = {
    id: project.id, projectId: project.id, names: { ...DEFAULT_NAMES }, notes: '', results: [], indicators: [],
    createdBy: req.user.id, createdAt: now(), updatedAt: now(),
  };
  try {
    const saved = await req.db.create('logframes', doc);
    audit(req, 'create', 'logframes', project.id, `Set up the logframe for ${project.title}`);
    return saved;
  } catch (err) {
    if (err.code === 409) return mustFramework(req.db, project.id); // a colleague set it up a moment earlier
    throw err;
  }
}

function readSettings(body) {
  const out = { names: {}, notes: str(body.notes, 4000) };
  for (const level of LEVELS) out.names[level] = str(body[`name_${level}`] ?? (body.names && body.names[level]), 60) || DEFAULT_NAMES[level];
  return out;
}

async function updateSettings(req, fw, v, { ifMatch } = {}) {
  mustAdmin(req.user);
  const saved = await saveFramework(req.db, fw, (cur) => ({ ...cur, ...v }), { ifMatch });
  audit(req, 'update', 'logframes', fw.id, 'Changed the logframe level names and notes');
  return saved;
}

/** Planned activities linked to a logframe: { plan, item } for every work plan activity that points at it. */
async function linkedActivities(db, fwId) {
  const plans = await db.find('workplans', { fields: ['id', 'title', 'status', 'currency', 'items', 'periodStart'] });
  const out = [];
  for (const plan of plans) {
    for (const item of plan.items || []) if (item.logframeId === fwId && item.logframeResultId) out.push({ plan, item });
  }
  return out;
}

/** Clear the logframe link of planned activities (when a result or the whole logframe is removed). */
async function unlinkActivities(db, fwId, resultIds = null) {
  const hit = (it) => it.logframeId === fwId && (!resultIds || resultIds.includes(it.logframeResultId));
  const plans = await db.find('workplans', { fields: ['id', 'items'] });
  let count = 0;
  for (const { id, items } of plans) {
    if (!(items || []).some(hit)) continue;
    const plan = await db.get('workplans', id);
    if (!plan) continue;
    await saveLatest(db, 'workplans', plan, (cur) => {
      const next = (cur.items || []).map((it) => {
        if (!hit(it)) return it;
        count += 1;
        return { ...it, logframeId: '', logframeResultId: '' };
      });
      return { ...cur, items: next };
    }, { reload: () => db.get('workplans', id) });
  }
  return count;
}

async function deleteFramework(req, fw) {
  mustAdmin(req.user);
  await req.db.remove('logframes', fw.id);
  const unlinked = await unlinkActivities(req.db, fw.id);
  audit(req, 'delete', 'logframes', fw.id, `Deleted the logframe (${unlinked} planned activities unlinked)`);
  return { unlinked };
}

// ---------- Structure and numbering ----------
const childrenOf = (fw) => {
  const out = {};
  for (const r of fw.results || []) (out[r.parentId || ''] = out[r.parentId || ''] || []).push(r);
  return out;
};

/** Results in reading order (each followed by what is under it), with their depth. */
function ordered(fw) {
  const kids = childrenOf(fw);
  const out = [];
  const walk = (parentId, depth) => {
    for (const r of kids[parentId] || []) {
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/**
 * Numbers in the usual logframe style: intermediate objectives 1, 2, 3; outputs 1.1, 1.2; activities
 * 1.1.1. A code typed in by the person (for example the donor's numbering) is used instead.
 */
function codes(fw) {
  const kids = childrenOf(fw);
  const out = {};
  const walk = (parentId, prefix) => {
    (kids[parentId] || []).forEach((r, i) => {
      const auto = r.level === 'objective' ? '' : `${prefix ? `${prefix}.` : ''}${i + 1}`;
      out[r.id] = r.code || auto;
      walk(r.id, r.level === 'objective' ? '' : out[r.id]);
    });
  };
  walk('', '');
  return out;
}

/** "Output 1.2" or "Overall objective". */
function labelOf(fw, r, codeMap = codes(fw)) {
  const n = names(fw)[r.level] || r.level;
  return codeMap[r.id] ? `${n} ${codeMap[r.id]}` : n;
}

function getResult(fw, resultId) {
  const r = (fw.results || []).find((x) => x.id === resultId);
  if (!r) throw notFound('Logframe result');
  return r;
}

function readResult(body) {
  return {
    level: LEVELS.includes(body.level) ? body.level : str(body.level, 20),
    parentId: str(body.parentId, 60),
    code: str(body.code, 20),
    text: str(body.text, 1500),
  };
}

function validateResult(fw, v, resultId = null) {
  const e = {};
  if (!LEVELS.includes(v.level)) e.level = 'Choose objective, outcome, output or activity.';
  if (!v.text) e.text = 'Write the result or activity.';
  const parentLevel = PARENT_LEVEL[v.level];
  if (parentLevel === 'objective') {
    // Intermediate objectives sit under the overall objective when there is one.
    const objective = (fw.results || []).find((r) => r.level === 'objective');
    v.parentId = objective ? objective.id : '';
  } else if (parentLevel) {
    const parent = (fw.results || []).find((r) => r.id === v.parentId);
    if (!parent || parent.level !== parentLevel || parent.id === resultId) e.parentId = `Choose the ${names(fw)[parentLevel].toLowerCase()} it belongs to.`;
  } else {
    v.parentId = '';
  }
  return e;
}

async function addResult(req, fw, v) {
  mustAdmin(req.user);
  const result = { id: newId(), ...v };
  const saved = await saveFramework(req.db, fw, (cur) => {
    const e = validateResult(cur, v);
    if (Object.keys(e).length) throw invalid(e);
    Object.assign(result, { parentId: v.parentId });
    return { ...cur, results: [...(cur.results || []), result] };
  });
  audit(req, 'update', 'logframes', fw.id, `Logframe: added ${names(fw)[v.level].toLowerCase()} "${v.text.slice(0, 80)}"`);
  return { framework: saved, result };
}

async function updateResult(req, fw, resultId, v, { ifMatch } = {}) {
  mustAdmin(req.user);
  let result;
  const saved = await saveFramework(req.db, fw, (cur) => {
    const old = getResult(cur, resultId);
    const next = { ...v, level: old.level };
    const e = validateResult(cur, next, resultId);
    if (Object.keys(e).length) throw invalid(e);
    result = { ...old, ...next };
    return { ...cur, results: cur.results.map((r) => (r.id === resultId ? result : r)) };
  }, { ifMatch });
  audit(req, 'update', 'logframes', fw.id, `Logframe: changed "${result.text.slice(0, 80)}"`);
  return { framework: saved, result };
}

/** Remove a result with its indicators. Results under it must be removed first; planned activities are unlinked. */
async function deleteResult(req, fw, resultId, { ifMatch } = {}) {
  mustAdmin(req.user);
  const old = getResult(fw, resultId);
  const saved = await saveFramework(req.db, fw, (cur) => {
    getResult(cur, resultId);
    const under = (cur.results || []).filter((r) => r.parentId === resultId);
    if (under.length) {
      throw new HttpError(409, 'has_children', `Remove the ${under.length} ${under.length === 1 ? 'entry' : 'entries'} under it first.`);
    }
    return {
      ...cur,
      results: cur.results.filter((r) => r.id !== resultId),
      indicators: (cur.indicators || []).filter((i) => i.resultId !== resultId),
    };
  }, { ifMatch });
  const unlinked = await unlinkActivities(req.db, fw.id, [resultId]);
  audit(req, 'update', 'logframes', fw.id, `Logframe: removed "${old.text.slice(0, 80)}" (${unlinked} planned activities unlinked)`);
  return { framework: saved, unlinked };
}

// ---------- Indicators ----------
function getIndicator(fw, indicatorId) {
  const ind = (fw.indicators || []).find((x) => x.id === indicatorId);
  if (!ind) throw notFound('Indicator');
  return ind;
}

function readIndicator(body) {
  const source = SOURCES[body.source] ? body.source : str(body.source, 30) || 'manual';
  const unit = SOURCES[source] && SOURCES[source].unit ? SOURCES[source].unit : str(body.unit, 20) || 'number';
  return {
    resultId: str(body.resultId, 60),
    name: str(body.name, 500),
    unit,
    baseline: numOrNull(body.baseline),
    target: numOrNull(body.target),
    source,
    means: str(body.means, 500),
    frequency: str(body.frequency, 100),
  };
}

function validateIndicator(fw, v) {
  const e = {};
  if (!v.name) e.name = 'Write the indicator, for example "Community members reached through awareness raising".';
  if (!(fw.results || []).some((r) => r.id === v.resultId)) e.resultId = 'Choose the result the indicator measures.';
  if (!UNITS.includes(v.unit)) e.unit = 'Choose number or percent.';
  if (!SOURCES[v.source]) e.source = 'Choose where the value comes from.';
  for (const f of ['baseline', 'target']) {
    if (Number.isNaN(v[f])) e[f] = 'Enter a number.';
    else if (v.unit === 'percent' && v[f] !== null && (v[f] < 0 || v[f] > 100)) e[f] = 'Enter a percentage from 0 to 100.';
  }
  return e;
}

async function addIndicator(req, fw, v) {
  mustAdmin(req.user);
  const ind = { id: newId(), ...v, values: [], createdAt: now() };
  const saved = await saveFramework(req.db, fw, (cur) => {
    const e = validateIndicator(cur, v);
    if (Object.keys(e).length) throw invalid(e);
    return { ...cur, indicators: [...(cur.indicators || []), ind] };
  });
  audit(req, 'update', 'logframes', fw.id, `Logframe: added indicator "${v.name.slice(0, 80)}"`);
  return { framework: saved, indicator: ind };
}

async function updateIndicator(req, fw, indicatorId, v, { ifMatch } = {}) {
  mustAdmin(req.user);
  let ind;
  const saved = await saveFramework(req.db, fw, (cur) => {
    const old = getIndicator(cur, indicatorId);
    const e = validateIndicator(cur, v);
    if (Object.keys(e).length) throw invalid(e);
    ind = { ...old, ...v };
    return { ...cur, indicators: cur.indicators.map((i) => (i.id === indicatorId ? ind : i)) };
  }, { ifMatch });
  audit(req, 'update', 'logframes', fw.id, `Logframe: changed indicator "${ind.name.slice(0, 80)}"`);
  return { framework: saved, indicator: ind };
}

async function deleteIndicator(req, fw, indicatorId, { ifMatch } = {}) {
  mustAdmin(req.user);
  const old = getIndicator(fw, indicatorId);
  const saved = await saveFramework(req.db, fw, (cur) => {
    getIndicator(cur, indicatorId);
    return { ...cur, indicators: cur.indicators.filter((i) => i.id !== indicatorId) };
  }, { ifMatch });
  audit(req, 'update', 'logframes', fw.id, `Logframe: removed indicator "${old.name.slice(0, 80)}" and its ${(old.values || []).length} values`);
  return saved;
}

// ---------- Recorded values ----------
function readValue(body) {
  return { date: str(body.date, 10), value: numOrNull(body.value), note: str(body.note, 500) };
}

function validateValue(ind, v, t0 = today()) {
  const e = {};
  if (!isRealDate(v.date)) e.date = 'Enter the date the value applies to.';
  else if (v.date > t0) e.date = 'The date cannot be in the future.';
  if (v.value === null || Number.isNaN(v.value)) e.value = 'Enter the value as a number.';
  else if (ind.unit === 'percent' && (v.value < 0 || v.value > 100)) e.value = 'Enter a percentage from 0 to 100.';
  return e;
}

const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.at).localeCompare(String(b.at));

/** Anyone can record the value of an indicator measured by staff, as at a date. */
async function addValue(req, fw, indicatorId, v) {
  const ind = getIndicator(fw, indicatorId);
  if (ind.source !== 'manual') throw new HttpError(422, 'automatic_indicator', 'This indicator is worked out automatically, so values cannot be recorded for it.');
  const entry = { id: newId(), ...v, by: req.user.id, at: now() };
  const saved = await saveFramework(req.db, fw, (cur) => {
    const current = getIndicator(cur, indicatorId);
    const e = validateValue(current, v);
    if (Object.keys(e).length) throw invalid(e);
    const values = [...(current.values || []), entry].sort(byDate);
    return { ...cur, indicators: cur.indicators.map((i) => (i.id === indicatorId ? { ...i, values } : i)) };
  });
  audit(req, 'update', 'logframes', fw.id, `Indicator "${ind.name.slice(0, 60)}": recorded ${v.value} as at ${v.date}`);
  return { framework: saved, value: entry };
}

/** The colleague who recorded a value, or an administrator, can remove it. */
async function deleteValue(req, fw, indicatorId, valueId) {
  const ind = getIndicator(fw, indicatorId);
  const entry = (ind.values || []).find((x) => x.id === valueId);
  if (!entry) throw notFound('Value');
  if (entry.by !== req.user.id && !isAdmin(req.user)) throw forbidden('Only the colleague who recorded this value, or an administrator, can remove it.');
  const saved = await saveFramework(req.db, fw, (cur) => ({
    ...cur,
    indicators: cur.indicators.map((i) => (i.id === indicatorId ? { ...i, values: (i.values || []).filter((x) => x.id !== valueId) } : i)),
  }));
  audit(req, 'update', 'logframes', fw.id, `Indicator "${ind.name.slice(0, 60)}": removed the value ${entry.value} of ${entry.date}`);
  return saved;
}

// ---------- Progress ----------
function emptyRollup() {
  return {
    planned: 0, completed: 0, overdue: 0, targetEvents: 0, delivered: 0, targetPeople: 0, attendances: 0,
    attendees: 0, heads: 0, reach: 0, women: 0, children: 0, disabled: 0, budget: {}, byAge: {},
  };
}

const AGE_ORDER = ['Woman', 'Man', 'Girl', 'Boy'];

/** Totals for a set of planned activities and their reports. */
function rollup(links, reportsOf, people, t0) {
  const out = emptyRollup();
  const seen = new Set();
  for (const { plan, item } of links) {
    if (item.status === 'Cancelled') continue;
    out.planned += 1;
    if (item.status === 'Completed') out.completed += 1;
    if (item.endDate && item.endDate < t0 && !DONE.includes(item.status)) out.overdue += 1;
    out.targetEvents += Number(item.targetEvents) || 0;
    out.targetPeople += Number(item.targetPeople) || 0;
    if (item.budget) {
      const cur = plan.currency || 'ZMW';
      out.budget[cur] = Math.round(((out.budget[cur] || 0) + Number(item.budget)) * 100) / 100;
    }
    for (const r of reportsOf(plan, item)) {
      out.delivered += 1;
      if (!attendanceCounts(r)) continue; // people reached count approved attendance only
      out.heads += r.otherParticipants || 0;
      out.attendances += (r.attendeeIds || []).length;
      for (const id of r.attendeeIds || []) if (people[id]) seen.add(id);
    }
  }
  const regs = [...seen].map((id) => people[id]);
  out.attendees = regs.length;
  out.reach = regs.length + out.heads;
  out.women = regs.filter((p) => ['Woman', 'Girl'].includes(p.ageCategory)).length;
  out.children = regs.filter((p) => ['Girl', 'Boy'].includes(p.ageCategory)).length;
  out.disabled = regs.filter((p) => p.disability === 'Disabled').length;
  for (const p of regs) {
    const k = AGE_ORDER.includes(p.ageCategory) ? p.ageCategory : 'Not recorded';
    out.byAge[k] = (out.byAge[k] || 0) + 1;
  }
  return out;
}

const SEVERITY = ['Behind', 'Below target', 'On track', 'Achieved'];

/**
 * One status for a result from its own indicators: the most serious one among those with a value
 * (Behind, then Below target, then On track), Achieved when all are achieved, No data otherwise.
 */
function health(inds) {
  const measured = inds.filter((i) => SEVERITY.includes(i.status));
  if (!measured.length) return inds.length ? 'No data' : 'No indicators';
  return SEVERITY.find((s) => measured.some((i) => i.status === s));
}

/** Where a count should be by now if it grows evenly over the project period. */
function expectedNow(ind, elapsed) {
  if (ind.unit === 'percent' || elapsed === null || ind.target === null || ind.target === undefined) return null;
  const base = ind.baseline ?? 0;
  return Math.round((base + ((ind.target - base) * elapsed) / 100) * 10) / 10;
}

const share = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : null);

function autoValue(source, agg, projectTotals) {
  const map = {
    reports: agg.delivered,
    reach: agg.reach,
    attendees: agg.attendees,
    women: agg.women,
    children: agg.children,
    disabled: agg.disabled,
    womenPct: share(agg.women, agg.attendees),
    childrenPct: share(agg.children, agg.attendees),
    disabledPct: share(agg.disabled, agg.attendees),
    casesOpened: projectTotals ? projectTotals.opened : null,
    clientsServed: projectTotals ? projectTotals.served : null,
    referrals: projectTotals ? projectTotals.referrals : null,
  };
  return map[source] ?? null;
}

/** Progress towards the target and a plain status, compared with the time elapsed for counts. */
function judge(ind, actual, elapsed) {
  if (actual === null || actual === undefined) return { pct: null, status: 'No data' };
  if (ind.target === null || ind.target === undefined) return { pct: null, status: 'No target' };
  const base = ind.baseline ?? 0;
  let pct;
  if (ind.target === base) pct = actual === ind.target ? 100 : 0;
  else pct = Math.max(0, Math.round(((actual - base) / (ind.target - base)) * 100));
  if (pct >= 100) return { pct, status: 'Achieved' };
  // A share (for example 60% women) is either at its target or below it; a count is judged against the time elapsed.
  if (ind.unit === 'percent') return { pct, status: 'Below target' };
  if (elapsed === null || pct >= elapsed - 10) return { pct, status: 'On track' };
  return { pct, status: 'Behind' };
}

/** Share of the project period that has passed (0 to 100), or null without dates. */
function timeElapsed(project, t0 = today()) {
  if (!project || !isRealDate(project.startDate) || !isRealDate(project.endDate)) return null;
  const total = daysBetween(project.startDate, project.endDate);
  if (!total || total <= 0) return null;
  const gone = daysBetween(project.startDate, t0);
  return Math.max(0, Math.min(100, Math.round((gone / total) * 100)));
}

/**
 * The logframe with progress: every result with its code, its indicators (value, progress, status) and the
 * totals of the planned activities linked to it or to anything under it, plus the planned activities of
 * the project's work plans that are not linked yet.
 */
async function progress(db, fw, project, t0 = today()) {
  const codeMap = codes(fw);
  const kids = childrenOf(fw);
  const links = await linkedActivities(db, fw.id);
  const planIds = [...new Set(links.map((l) => l.plan.id))];
  const reports = [];
  for (let i = 0; i < planIds.length; i += 100) {
    reports.push(...await db.find('reports', {
      where: { workplanId: { $in: planIds.slice(i, i + 100) } },
      fields: ['id', 'heading', 'date', 'workplanId', 'workplanItemId', 'attendeeIds', 'otherParticipants', 'attendanceStatus'],
    }));
  }
  const reportsOf = (plan, item) => reports.filter((r) => r.workplanId === plan.id && r.workplanItemId === item.id);
  const people = await mapByIds(db, 'people', reports.flatMap((r) => r.attendeeIds || []));

  const below = (id) => {
    const out = new Set([id]);
    const stack = [id];
    while (stack.length) for (const c of kids[stack.pop()] || []) if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
    return out;
  };
  const indicators = fw.indicators || [];
  const needsCases = indicators.some((i) => SOURCES[i.source] && SOURCES[i.source].scope === 'project');
  let projectTotals = null;
  if (needsCases && project && isRealDate(project.startDate) && project.startDate <= t0) {
    const to = isRealDate(project.endDate) && project.endDate < t0 ? project.endDate : t0;
    projectTotals = (await compute(db, { from: project.startDate, to, office: '', projectId: project.id })).totals;
  }
  const elapsed = timeElapsed(project, t0);

  const results = ordered(fw).map((r) => {
    // The overall objective counts every linked activity, including any under results outside it.
    const ids = r.level === 'objective' ? null : below(r.id);
    const mine = links.filter((l) => !ids || ids.has(l.item.logframeResultId));
    const agg = rollup(mine, reportsOf, people, t0);
    const inds = indicators.filter((i) => i.resultId === r.id).map((ind) => {
      const manual = ind.source === 'manual' || !SOURCES[ind.source];
      const last = manual && (ind.values || []).length ? [...ind.values].sort(byDate).pop() : null;
      const value = manual ? (last ? last.value : null) : autoValue(ind.source, agg, projectTotals);
      return {
        ...ind, actual: value, asAt: manual ? (last ? last.date : null) : t0, automatic: !manual, expected: expectedNow(ind, elapsed), ...judge(ind, value, elapsed),
      };
    });
    return {
      ...r,
      code: codeMap[r.id],
      label: labelOf(fw, r, codeMap),
      indicators: inds,
      health: health(inds),
      rollup: agg,
      direct: links.filter((l) => l.item.logframeResultId === r.id).map(({ plan, item }) => ({
        plan: { id: plan.id, title: plan.title, status: plan.status, currency: plan.currency },
        item,
        delivered: reportsOf(plan, item).length,
      })),
    };
  });

  const allInds = results.flatMap((r) => r.indicators);
  const count = (s) => allInds.filter((i) => i.status === s).length;
  const projectPlans = project
    ? await db.find('workplans', { where: { projectId: project.id }, fields: ['id', 'title', 'items'] })
    : [];
  const unlinked = projectPlans.flatMap((p) => (p.items || [])
    .filter((it) => it.status !== 'Cancelled' && !(it.logframeId && it.logframeResultId))
    .map((it) => ({ plan: { id: p.id, title: p.title }, item: it })));
  // Targets for the shares of women and girls, children and persons with disabilities, if the logframe has them.
  const shareTarget = (source) => {
    const i = allInds.find((x) => x.source === source && x.target !== null && x.target !== undefined);
    return i ? i.target : null;
  };
  return {
    results,
    elapsed,
    overall: rollup(links, reportsOf, people, t0),
    shareTargets: { women: shareTarget('womenPct'), children: shareTarget('childrenPct'), disabled: shareTarget('disabledPct') },
    totals: {
      indicators: allInds.length,
      achieved: count('Achieved'),
      onTrack: count('On track'),
      behind: count('Behind') + count('Below target'),
      noData: count('No data') + count('No target'),
      linked: links.filter((l) => l.item.status !== 'Cancelled').length,
      reports: links.reduce((n, l) => n + reportsOf(l.plan, l.item).length, 0),
      unlinked: unlinked.length,
    },
    unlinked,
  };
}

// ---------- Planned activities: the choice of output or activity ----------
/**
 * Choices for the "Logframe" field of a planned activity, grouped by project: the outputs and activities
 * of the plan's project logframe (or of every logframe when the plan is not for one project), plus the
 * current link.
 */
async function linkOptions(db, { projectId = '', current = {}, onlyPlannable = false } = {}) {
  let fws = projectId ? [await getFramework(db, projectId)].filter(Boolean) : await db.find('logframes', {});
  if (!onlyPlannable && current.logframeId && !fws.some((f) => f.id === current.logframeId)) {
    const extra = await getFramework(db, current.logframeId);
    if (extra) fws = [...fws, extra];
  }
  const projects = await mapByIds(db, 'projects', fws.map((f) => f.projectId));
  const groups = [];
  for (const fw of fws) {
    const codeMap = codes(fw);
    const leaf = new Set(plannable(fw).map((r) => r.resultId));
    const options = ordered(fw).filter((r) => r.level === 'output' || r.level === 'activity').filter((r) => !onlyPlannable || leaf.has(r.id)).map((r) => {
      const text = r.text.length > 90 ? `${r.text.slice(0, 88)}\u2026` : r.text;
      return {
        value: `${fw.id}:${r.id}`, label: `${r.level === 'activity' ? '\u2003' : ''}${labelOf(fw, r, codeMap)}: ${text}`, text: r.text.slice(0, 300), level: r.level,
      };
    });
    if (options.length) groups.push({ label: projects[fw.projectId] ? projects[fw.projectId].title : 'Project', options });
  }
  return groups;
}

/**
 * What a work plan can draw from a logframe: every activity (and every output without activities), in
 * logframe order, with its output and how many planned activities of the given plan already deliver it.
 */
function plannable(fw, plan = null) {
  const codeMap = codes(fw);
  const rows = ordered(fw);
  const out = [];
  let output = null;
  for (const r of rows) {
    if (r.level === 'output') output = r;
    const isLeafOutput = r.level === 'output' && !rows.some((x) => x.parentId === r.id && x.level === 'activity');
    if (r.level !== 'activity' && !isLeafOutput) continue;
    const already = plan ? (plan.items || []).filter((it) => it.logframeId === fw.id && it.logframeResultId === r.id).length : 0;
    out.push({
      resultId: r.id, level: r.level, label: labelOf(fw, r, codeMap), text: r.text,
      outputId: output ? output.id : '', outputLabel: output ? labelOf(fw, output, codeMap) : '', outputText: output ? output.text : '', already,
    });
  }
  return out;
}

/** Short labels for linked planned activities: { "logframeId:resultId": "Activity 1.2.1: Community awareness-raising" }. */
async function linkLabels(db, items) {
  const ids = [...new Set((items || []).map((it) => it.logframeId).filter(Boolean))];
  const out = {};
  for (const id of ids) {
    const fw = await getFramework(db, id);
    if (!fw) continue;
    const codeMap = codes(fw);
    for (const r of fw.results || []) out[`${fw.id}:${r.id}`] = { label: labelOf(fw, r, codeMap), text: r.text, href: `/logframes/${fw.id}#res-${r.id}` };
  }
  return out;
}

// ---------- Spreadsheet import and export ----------
const LEVEL_WORDS = {
  objective: ['overall objective', 'objective', 'goal', 'overall goal', 'impact', 'development objective'],
  outcome: ['intermediate objective', 'intermediate objectives', 'outcome', 'specific objective', 'immediate objective', 'io'],
  output: ['output', 'outputs'],
  activity: ['activity', 'activities'],
  indicator: ['indicator', 'indicators'],
};
const levelOf = (word) => Object.keys(LEVEL_WORDS).find((k) => LEVEL_WORDS[k].includes(String(word || '').trim().toLowerCase()));

function sourceOf(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w || w === 'manual' || w === 'recorded') return 'manual';
  return Object.keys(SOURCES).find((k) => k.toLowerCase() === w || SOURCES[k].short.toLowerCase() === w || SOURCES[k].label.toLowerCase() === w) || null;
}

/** Rows of a CSV file, or of cells copied from Excel (tab separated). Handles quotes and line breaks in cells. */
function parseRows(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const IMPORT_COLUMNS = ['Level', 'Code', 'Text', 'Unit', 'Baseline', 'Target', 'Means of verification', 'Source'];

/**
 * Read a logframe written one row per line: Level, Code, Text, then for indicators Unit, Baseline, Target,
 * Means of verification and Source. An intermediate objective belongs to the overall objective above it,
 * an output to the intermediate objective above it, an activity to the output above it, and an indicator
 * to the result row above it. Returns { results, indicators, errors } with errors by row number.
 */
function parseOutline(text) {
  const rows = parseRows(text);
  const errors = {};
  const results = [];
  const indicators = [];
  // Row numbers match the spreadsheet, where the column names are row 1.
  const first = rows.length && /^level$/i.test(rows[0][0]) ? 2 : 1;
  if (first === 2) rows.shift();
  if (rows.length > 600) return { results, indicators, errors: { 0: 'Import at most 600 rows at a time.' } };
  const last = {};
  let lastResult = null;
  rows.forEach((cells, i) => {
    const n = i + first;
    const [levelWord, code = '', txt = '', unitWord = '', baseline = '', target = '', means = '', sourceWord = ''] = cells;
    const level = levelOf(levelWord);
    if (!level) { errors[n] = `Row ${n}: "${levelWord}" is not a level. Use Overall objective, Intermediate objective, Output, Activity or Indicator.`; return; }
    if (!txt) { errors[n] = `Row ${n}: the text is empty.`; return; }
    if (level === 'indicator') {
      if (!lastResult) { errors[n] = `Row ${n}: an indicator must come after the result it measures.`; return; }
      const source = sourceOf(sourceWord);
      if (!source) { errors[n] = `Row ${n}: "${sourceWord}" is not a known source. Leave it empty for values recorded by staff.`; return; }
      let unit = /^(percent|percentage|%)$/i.test(unitWord) ? 'percent' : 'number';
      if (SOURCES[source].unit) unit = SOURCES[source].unit;
      const v = {
        id: newId(), resultId: lastResult.id, name: txt.slice(0, 500), unit, baseline: numOrNull(baseline), target: numOrNull(target),
        source, means: means.slice(0, 500), frequency: '', values: [], createdAt: now(),
      };
      if (Number.isNaN(v.baseline) || Number.isNaN(v.target)) { errors[n] = `Row ${n}: the baseline and target must be numbers.`; return; }
      indicators.push(v);
      return;
    }
    const parentLevel = PARENT_LEVEL[level];
    let parentId = '';
    if (parentLevel) {
      const parent = last[parentLevel];
      if (!parent && parentLevel !== 'objective') {
        errors[n] = `Row ${n}: put this ${level === 'output' ? 'output under an intermediate objective' : 'activity under an output'}.`;
        return;
      }
      parentId = parent ? parent.id : '';
    }
    const r = { id: newId(), level, parentId, code: code.slice(0, 20), text: txt.slice(0, 1500) };
    results.push(r);
    last[level] = r;
    // A new result closes the ones below it, so a later activity cannot attach to an earlier output by mistake.
    for (let l = LEVELS.indexOf(level) + 1; l < LEVELS.length; l += 1) delete last[LEVELS[l]];
    lastResult = r;
  });
  return { results, indicators, errors };
}

/** Fill an empty logframe from a spreadsheet. Nothing is saved if any row has a problem. */
async function importOutline(req, fw, text) {
  mustAdmin(req.user);
  const parsed = parseOutline(text);
  if (!parsed.results.length && !Object.keys(parsed.errors).length) parsed.errors[0] = 'Nothing to import. Paste the rows or choose a CSV file.';
  if (Object.keys(parsed.errors).length) {
    const err = invalid({ outline: 'Some rows need attention. Nothing was imported.' });
    err.rowErrors = parsed.errors;
    throw err;
  }
  const saved = await saveFramework(req.db, fw, (cur) => {
    if ((cur.results || []).length) throw new HttpError(409, 'not_empty', 'The logframe already has entries. Import works on an empty logframe only.');
    return { ...cur, results: parsed.results, indicators: parsed.indicators };
  });
  audit(req, 'update', 'logframes', fw.id, `Logframe imported: ${parsed.results.length} entries and ${parsed.indicators.length} indicators`);
  return { framework: saved, results: parsed.results.length, indicators: parsed.indicators.length };
}

const LEVEL_EXPORT = { objective: 'Overall objective', outcome: 'Intermediate objective', output: 'Output', activity: 'Activity' };

/** Rows for the CSV export: the import columns first (so an export can be imported again), then progress. */
function exportRows(fw, prog) {
  const rows = [];
  for (const r of prog.results) {
    rows.push({ level: LEVEL_EXPORT[r.level], code: r.code, text: r.text, delivered: r.rollup.delivered, reach: r.rollup.reach, planned: r.rollup.planned });
    for (const i of r.indicators) {
      rows.push({
        level: 'Indicator', code: '', text: i.name, unit: i.unit === 'percent' ? 'Percent' : 'Number', baseline: i.baseline, target: i.target,
        means: i.means, source: (SOURCES[i.source] || SOURCES.manual).short, actual: i.actual, asAt: i.asAt, pct: i.pct, status: i.status,
      });
    }
  }
  return rows;
}

function template() {
  const rows = [
    IMPORT_COLUMNS,
    ['Overall objective', '', 'To expand legal empowerment and access to justice for vulnerable communities'],
    ['Intermediate objective', '1', 'Improved understanding of rights among communities'],
    ['Output', '1.1', 'At least 1,500 community members are reached through awareness raising'],
    ['Indicator', '', 'Community members reached through awareness raising', 'Number', '0', '1500', 'Attendance registers', 'People reached'],
    ['Indicator', '', 'Share of women and girls among registered attendees', 'Percent', '0', '60', 'Attendance registers', 'Women and girls (%)'],
    ['Activity', '1.1.1', 'Community awareness-raising by paralegals'],
  ];
  const esc = (c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `\uFEFF${rows.map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}

/** Display helpers. */
const STATUS_LOOK = {
  Achieved: { cls: 'tag-done', icon: 'check-circle' },
  'On track': { cls: '', icon: 'arrow-right-circle' },
  Behind: { cls: 'tag-warn', icon: 'exclamation-triangle' },
  'Below target': { cls: 'tag-warn', icon: 'exclamation-triangle' },
  'No target': { cls: 'tag-muted', icon: 'dash-circle' },
  'No data': { cls: 'tag-muted', icon: 'dash-circle' },
  'No indicators': { cls: 'tag-muted', icon: 'dash-circle' },
};
const view = {
  status: (s) => STATUS_LOOK[s] || STATUS_LOOK['No data'],
  num: (n, unit) => {
    if (n === null || n === undefined || n === '') return '';
    const s = Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 });
    return unit === 'percent' ? `${s}%` : s;
  },
  money: (budget) => Object.entries(budget || {}).map(([cur, n]) => `${cur} ${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`).join(' · '),
};

module.exports = {
  LEVELS, PARENT_LEVEL, CHILD_LEVEL, DEFAULT_NAMES, SOURCES, UNITS, IMPORT_COLUMNS,
  names, getFramework, mustFramework, canChange, createFramework, readSettings, updateSettings, deleteFramework,
  ordered, codes, labelOf, getResult, readResult, validateResult, addResult, updateResult, deleteResult,
  getIndicator, readIndicator, validateIndicator, addIndicator, updateIndicator, deleteIndicator,
  readValue, validateValue, addValue, deleteValue, progress, judge, health, timeElapsed, linkOptions, linkLabels,
  parseRows, parseOutline, importOutline, exportRows, template, unlinkActivities, plannable, view,
};
