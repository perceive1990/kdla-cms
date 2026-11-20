<script setup>
// Activity reports, live, with their attendance status and payments. Every report is in the browser, so
// typing, choosing a filter or sorting changes the list at once; the search also asks the server, which reads
// the text of the reports too. Totals for the reports shown sit above the list. The filters stay in the
// address bar, and Print and Export CSV use them.
import {
  computed, reactive, ref, toRaw, watch,
} from 'vue';
import SortHeader from '../components/sort-header.vue';
import FilterChips from '../components/filter-chips.vue';
import ShowMore from '../components/show-more.vue';
import { readParams, writeParams, toQuery } from '../lib/address.js';
import { useServerSearch } from '../lib/search.js';
import { usePrintAll } from '../lib/print.js';
import {
  plural, money, searchTerm, contains, isDate, dateLabel, sortRows,
} from '../lib/text.js';

const props = defineProps({
  source: { type: Object, required: true },
  typed: { type: Object, default: () => ({}) },
});

const d = toRaw(props.source.state.data);
const { lists } = d;
const reports = d.reports;
const total = reports.length;
const attendanceLabels = Object.fromEntries(lists.attendance);
const PAY = { yes: 'Payments recorded', none: 'No payments recorded' };

const SORTS = {
  date: { get: (r) => r.date, dir: 'desc' },
  heading: { get: (r) => r.heading, dir: 'asc' },
  activity: { get: (r) => r.activity, dir: 'asc' },
  office: { get: (r) => r.office, dir: 'asc' },
  attendees: { get: (r) => r.attendees, dir: 'desc' },
  attendance: { get: (r) => r.attendanceLabel, dir: 'asc' },
  pay: { get: (r) => (r.pay ? r.pay.total : null), dir: 'desc' },
  compiledBy: { get: (r) => r.compiledBy, dir: 'asc' },
};

const start = readParams(['q', 'activityType', 'attendance', 'office', 'district', 'pay', 'projectId', 'workplanId', 'from', 'to', 'sort', 'dir']);
const valid = (v, list) => (list.includes(v) ? v : '');
const f = reactive({
  q: props.typed.q ?? start.q,
  activityType: valid(start.activityType, lists.activities),
  attendance: attendanceLabels[start.attendance] ? start.attendance : '',
  office: valid(start.office, lists.offices),
  district: valid(start.district, lists.districts),
  pay: PAY[start.pay] ? start.pay : '',
  projectId: start.projectId.slice(0, 60),
  workplanId: start.workplanId.slice(0, 60),
  from: isDate(start.from) ? start.from : '',
  to: isDate(start.to) ? start.to : '',
});
const sort = reactive(SORTS[start.sort]
  ? { field: start.sort, dir: ['asc', 'desc'].includes(start.dir) ? start.dir : SORTS[start.sort].dir }
  : { field: 'date', dir: 'desc' });
function sortBy(field) {
  if (sort.field === field) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  else Object.assign(sort, { field, dir: SORTS[field].dir });
}

const term = computed(() => searchTerm(f.q));
const { ids: found, searching, failed } = useServerSearch('/reports/data', computed(() => f.q));

/** The same rules as the list on the server (services/reports.js reportQuery), and the payments filter. */
function keep(r) {
  if (f.activityType && r.activity !== f.activityType) return false;
  if (f.attendance && r.attendance !== f.attendance) return false;
  if (f.office && r.office !== f.office) return false;
  if (f.district && r.district !== f.district) return false;
  if (f.pay === 'yes' && !r.pay) return false;
  if (f.pay === 'none' && r.pay) return false;
  if (f.projectId && r.projectId !== f.projectId) return false;
  if (f.workplanId && r.workplanId !== f.workplanId) return false;
  if (f.from && !(r.date && r.date >= f.from)) return false;
  if (f.to && !(r.date && r.date <= f.to)) return false;
  const t = term.value;
  return !t || contains(r.heading, t) || contains(r.venue, t) || found.value.has(r.id);
}

const matching = computed(() => reports.filter(keep));
const newestFirst = (a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0));
const sorted = computed(() => sortRows(matching.value, SORTS[sort.field].get, sort.dir, newestFirst));

const step = d.pageSize || 25;
const limit = ref(step);
const { printing, print } = usePrintAll();
const rows = computed(() => (printing.value ? sorted.value : sorted.value.slice(0, limit.value)));
const more = () => { limit.value += step; };
const showAll = () => { limit.value = sorted.value.length; };

const params = computed(() => ({
  q: term.value,
  activityType: f.activityType,
  attendance: f.attendance,
  office: f.office,
  district: f.district,
  pay: f.pay,
  projectId: f.projectId,
  workplanId: f.workplanId,
  from: f.from,
  to: f.to,
}));
const sortParams = computed(() => (sort.field === 'date' && sort.dir === 'desc' ? {} : { sort: sort.field, dir: sort.dir }));
let addressTimer = 0;
watch([params, sortParams], () => {
  limit.value = step;
  window.clearTimeout(addressTimer);
  addressTimer = window.setTimeout(() => writeParams({ ...params.value, ...sortParams.value }), 250);
});
const csvHref = computed(() => {
  const qs = toQuery(params.value);
  return `/reports/export.csv${qs ? `?${qs}` : ''}`;
});

const dated = () => {
  if (f.from && f.to) return `${dateLabel(f.from)} to ${dateLabel(f.to)}`;
  return f.from ? `From ${dateLabel(f.from)}` : `Up to ${dateLabel(f.to)}`;
};
const chips = computed(() => {
  const out = [];
  if (term.value) out.push({ key: 'q', label: `Search: ${term.value}` });
  if (f.activityType) out.push({ key: 'activityType', label: f.activityType });
  if (f.attendance) out.push({ key: 'attendance', label: `Attendance: ${attendanceLabels[f.attendance].toLowerCase()}` });
  if (f.office) out.push({ key: 'office', label: f.office });
  if (f.district) out.push({ key: 'district', label: f.district });
  if (f.pay) out.push({ key: 'pay', label: PAY[f.pay] });
  if (f.projectId) out.push({ key: 'projectId', label: `Project: ${d.projects[f.projectId] || 'not found'}` });
  if (f.workplanId) out.push({ key: 'workplanId', label: `Work plan: ${d.plans[f.workplanId] || 'not found'}` });
  if (f.from || f.to) out.push({ key: 'dates', label: dated() });
  return out;
});
function remove(key) {
  if (key === 'dates') { f.from = ''; f.to = ''; } else f[key] = '';
}
function clear() {
  Object.assign(f, {
    q: '', activityType: '', attendance: '', office: '', district: '', pay: '', projectId: '', workplanId: '', from: '', to: '',
  });
}

// Totals for the reports that match: attendees, and payments in each currency. Payments prepared on a
// planned activity count once across its sessions (the server works out each report's `unique` share).
const totals = computed(() => {
  let attendees = 0;
  const pay = {};
  for (const r of matching.value) {
    attendees += r.attendees;
    if (r.pay) pay[r.pay.currency] = (pay[r.pay.currency] || 0) + r.pay.unique;
  }
  return { attendees, pay: Object.entries(pay).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)) };
});
const summary = computed(() => (chips.value.length ? `${matching.value.length.toLocaleString('en-GB')} of ${plural(total, 'report')}` : plural(total, 'report')));
const payLine = (p) => [p.people ? plural(p.people, 'person', 'people') : '', p.activity ? `activity costs ${money(p.activity)}` : ''].filter(Boolean).join(' · ');

const announced = ref('');
let sayTimer = 0;
watch(() => matching.value.length, (n) => {
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => { announced.value = `${plural(n, 'report')} ${chips.value.length ? 'match' : 'in the list'}`; }, 700);
});
</script>

<template>
  <div class="page-head">
    <div><h1>Activity reports</h1><p class="sub">Community meetings, trainings, radio programmes and other outreach</p></div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-secondary" type="button" @click="print"><i class="bi bi-printer" aria-hidden="true"></i> Print</button>
      <a class="btn btn-outline-secondary" :href="csvHref"><i class="bi bi-download" aria-hidden="true"></i> Export CSV</a>
      <a class="btn btn-primary" href="/reports/new"><i class="bi bi-plus-lg" aria-hidden="true"></i> New report</a>
    </div>
  </div>

  <form class="filters d-print-none" role="search" @submit.prevent>
    <div class="search-box grow">
      <i class="bi bi-search" aria-hidden="true"></i>
      <input v-model="f.q" class="form-control" type="search" name="q" placeholder="Search reports" aria-label="Search reports" autocomplete="off">
    </div>
    <select v-model="f.activityType" class="form-select" name="activityType" aria-label="Activity">
      <option value="">All activities</option>
      <option v-for="s in lists.activities" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.attendance" class="form-select" name="attendance" aria-label="Attendance">
      <option value="">Any attendance</option>
      <option v-for="[v, l] in lists.attendance" :key="v" :value="v">{{ l }}</option>
    </select>
    <select v-model="f.office" class="form-select" name="office" aria-label="Office">
      <option value="">All offices</option>
      <option v-for="s in lists.offices" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.district" class="form-select" name="district" aria-label="District">
      <option value="">All districts</option>
      <option v-for="s in lists.districts" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.pay" class="form-select" name="pay" aria-label="Payments">
      <option value="">Any payments</option>
      <option value="yes">{{ PAY.yes }}</option>
      <option value="none">{{ PAY.none }}</option>
    </select>
  </form>

  <div class="results-bar">
    <p class="results-count">
      <strong>{{ summary }}</strong>
      <span class="results-total">{{ plural(totals.attendees, 'attendee') }}</span>
      <span v-for="[cur, n] in totals.pay" :key="cur" class="results-total">{{ cur }} {{ money(n) }} in payments</span>
      <span v-if="searching" class="results-note"><span class="spinner-dot" aria-hidden="true"></span>Searching the report text too</span>
      <span v-else-if="failed" class="results-note text-warning-emphasis">Could not search the report text; these match headings and venues</span>
    </p>
    <FilterChips :chips="chips" @remove="remove" @clear="clear" />
  </div>
  <p class="print-summary d-none d-print-block">{{ [summary, plural(totals.attendees, 'attendee'), ...totals.pay.map(([cur, n]) => `${cur} ${money(n)} in payments`)].join(' · ') }}<template v-if="chips.length">. Filters: {{ chips.map((c) => c.label).join('; ') }}</template></p>
  <p class="visually-hidden" aria-live="polite">{{ announced }}</p>

  <div v-if="!total" class="panel"><div class="empty"><i class="bi bi-journal-text" aria-hidden="true"></i>No reports found. <a href="/reports/new">Write the first report</a>.</div></div>
  <div v-else-if="!rows.length" class="panel">
    <div class="empty"><i class="bi bi-search" aria-hidden="true"></i>No reports match these filters.
      <button type="button" class="btn btn-link p-0 align-baseline" @click="clear">Clear the filters</button></div>
  </div>
  <div v-else class="table-wrap">
    <table class="table table-hover align-middle live-table">
      <thead>
        <tr>
          <SortHeader label="Date" field="date" :sort="sort" @sort="sortBy" />
          <SortHeader label="Heading" field="heading" :sort="sort" @sort="sortBy" />
          <SortHeader label="Activity" field="activity" :sort="sort" @sort="sortBy" />
          <SortHeader class="d-none d-md-table-cell" label="Office" field="office" :sort="sort" @sort="sortBy" />
          <SortHeader label="Attendees" field="attendees" :sort="sort" end @sort="sortBy" />
          <SortHeader class="d-none d-lg-table-cell" label="Attendance" field="attendance" :sort="sort" @sort="sortBy" />
          <SortHeader label="Payments" field="pay" :sort="sort" end @sort="sortBy" />
          <SortHeader class="d-none d-xxl-table-cell" label="Compiled by" field="compiledBy" :sort="sort" @sort="sortBy" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td class="nowrap">{{ r.dateLabel }}</td>
          <td class="cell-main"><a class="cell-strong" :href="`/reports/${r.id}`">{{ r.heading }}</a><div v-if="r.venue" class="small text-body-secondary">{{ r.venue }}</div></td>
          <td>{{ r.activity }}</td>
          <td class="d-none d-md-table-cell">{{ r.office }}<div v-if="r.district" class="small text-body-secondary">{{ r.district }}</div></td>
          <td class="text-end num-cell">{{ r.attendees.toLocaleString('en-GB') }}</td>
          <td class="d-none d-lg-table-cell"><span class="tag" :class="r.attendanceTone">{{ r.attendanceLabel }}</span></td>
          <td class="text-end num-cell">
            <template v-if="r.pay">
              <a class="pay-link" :href="`/reports/${r.id}/payments`">{{ r.pay.currency }} {{ money(r.pay.total) }}</a>
              <div v-if="payLine(r.pay)" class="small text-body-secondary">{{ payLine(r.pay) }}</div>
              <div v-if="r.pay.fromPlan" class="small text-body-secondary">from the work plan</div>
            </template>
            <span v-else class="small text-body-secondary">None recorded</span>
          </td>
          <td class="d-none d-xxl-table-cell">{{ r.compiledBy }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <ShowMore :shown="rows.length" :total="sorted.length" :step="step" @more="more" @all="showAll" />
</template>
