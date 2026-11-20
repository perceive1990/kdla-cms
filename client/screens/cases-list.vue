<script setup>
// Cases, live. Every case the person may see is in the browser, so typing, choosing a filter or sorting
// changes the list at once. The search also asks the server, which reads the complaint text too. The filters
// stay in the address bar, and Print and Export CSV use them.
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
  plural, searchTerm, contains, isDate, dateLabel, sortRows,
} from '../lib/text.js';

const props = defineProps({
  source: { type: Object, required: true },
  typed: { type: Object, default: () => ({}) },
});

const d = toRaw(props.source.state.data);
const { lists } = d;
const officerNames = new Map(d.officers.map((o) => [o.id, o.name]));
const named = (list) => list.filter(([, name]) => name);
const cases = d.cases.map((c) => ({ ...c, clientLinks: named(c.clients), otherLinks: named(c.others) }));
const clientNames = new Map(cases.flatMap((c) => c.clientLinks));
const total = cases.length;
const openStatuses = lists.statuses.filter((s) => s.startsWith('Open'));
const concludedStatuses = lists.statuses.filter((s) => s.startsWith('Concluded'));

const SORTS = {
  no: { get: (c) => c.no, dir: 'asc' },
  heading: { get: (c) => c.heading, dir: 'asc' },
  status: { get: (c) => c.status, dir: 'asc' },
  office: { get: (c) => c.office, dir: 'asc' },
  officer: { get: (c) => officerNames.get(c.officerId) || '', dir: 'asc' },
  updated: { get: (c) => c.updated, dir: 'desc' },
};

// Filters start from the address, as the server read them; a value the server would ignore is dropped.
const start = readParams(['q', 'status', 'type', 'office', 'officer', 'outcome', 'client', 'confidential', 'from', 'to', 'sort', 'dir']);
const valid = (v, list) => (list.includes(v) ? v : '');
const f = reactive({
  q: props.typed.q ?? start.q,
  status: ['open', 'concluded'].includes(start.status) ? start.status : valid(start.status, lists.statuses),
  type: valid(start.type, lists.types),
  office: valid(start.office, lists.offices),
  officer: start.officer === 'me' || officerNames.has(start.officer) ? start.officer : '',
  outcome: valid(start.outcome, lists.outcomes),
  client: start.client.slice(0, 60),
  confidential: start.confidential === '1' || start.confidential === 'true',
  from: isDate(start.from) ? start.from : '',
  to: isDate(start.to) ? start.to : '',
});
const sort = reactive(SORTS[start.sort]
  ? { field: start.sort, dir: ['asc', 'desc'].includes(start.dir) ? start.dir : SORTS[start.sort].dir }
  : { field: 'updated', dir: 'desc' });

function sortBy(field) {
  if (sort.field === field) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  else Object.assign(sort, { field, dir: SORTS[field].dir });
}

const term = computed(() => searchTerm(f.q));
const { ids: found, searching, failed } = useServerSearch('/cases/data', computed(() => f.q));

/** The same rules as the list on the server (services/cases.js caseQuery). */
function keep(c) {
  if (f.status === 'open') { if (!openStatuses.includes(c.status)) return false; }
  else if (f.status === 'concluded') { if (!concludedStatuses.includes(c.status)) return false; }
  else if (f.status && c.status !== f.status) return false;
  if (f.type && !c.types.includes(f.type)) return false;
  if (f.office && c.office !== f.office) return false;
  if (f.outcome && c.outcome !== f.outcome) return false;
  if (f.officer && c.officerId !== (f.officer === 'me' ? d.me : f.officer)) return false;
  if (f.client && !c.clients.some(([id]) => id === f.client)) return false;
  if (f.confidential && !c.restricted) return false;
  if (f.from && !(c.opened && c.opened >= f.from)) return false;
  if (f.to && !(c.opened && c.opened <= f.to)) return false;
  const t = term.value;
  return !t || contains(c.heading, t) || contains(c.no, t) || found.value.has(c.id);
}

const matching = computed(() => cases.filter(keep));
const newestFirst = (a, b) => (a.updated < b.updated ? 1 : (a.updated > b.updated ? -1 : 0));
const sorted = computed(() => sortRows(matching.value, SORTS[sort.field].get, sort.dir, newestFirst));

const step = d.pageSize || 25;
const limit = ref(step);
const { printing, print } = usePrintAll();
const rows = computed(() => (printing.value ? sorted.value : sorted.value.slice(0, limit.value)));
const more = () => { limit.value += step; };
const showAll = () => { limit.value = sorted.value.length; };

// The filters as the server reads them: kept in the address bar and given to Export CSV.
const params = computed(() => ({
  q: term.value,
  status: f.status,
  type: f.type,
  office: f.office,
  officer: f.officer,
  outcome: f.outcome,
  client: f.client,
  confidential: f.confidential ? '1' : '',
  from: f.from,
  to: f.to,
}));
const sortParams = computed(() => (sort.field === 'updated' && sort.dir === 'desc' ? {} : { sort: sort.field, dir: sort.dir }));
let addressTimer = 0;
watch([params, sortParams], () => {
  limit.value = step;
  window.clearTimeout(addressTimer);
  addressTimer = window.setTimeout(() => writeParams({ ...params.value, ...sortParams.value }), 250);
});
const csvHref = computed(() => {
  const qs = toQuery(params.value);
  return `/cases/export.csv${qs ? `?${qs}` : ''}`;
});

const opened = () => {
  if (f.from && f.to) return `Opened ${dateLabel(f.from)} to ${dateLabel(f.to)}`;
  return f.from ? `Opened from ${dateLabel(f.from)}` : `Opened up to ${dateLabel(f.to)}`;
};
const chips = computed(() => {
  const out = [];
  if (term.value) out.push({ key: 'q', label: `Search: ${term.value}` });
  if (f.status) out.push({ key: 'status', label: { open: 'All open cases', concluded: 'All concluded cases' }[f.status] || f.status });
  if (f.type) out.push({ key: 'type', label: f.type });
  if (f.office) out.push({ key: 'office', label: f.office });
  if (f.officer) out.push({ key: 'officer', label: f.officer === 'me' ? 'My cases' : `Officer: ${officerNames.get(f.officer)}` });
  if (f.outcome) out.push({ key: 'outcome', label: f.outcome });
  if (f.client) out.push({ key: 'client', label: `Client: ${clientNames.get(f.client) || 'not found'}` });
  if (f.confidential) out.push({ key: 'confidential', label: 'Confidential only' });
  if (f.from || f.to) out.push({ key: 'dates', label: opened() });
  return out;
});
function remove(key) {
  if (key === 'dates') { f.from = ''; f.to = ''; } else if (key === 'confidential') f.confidential = false;
  else f[key] = '';
}
function clear() {
  Object.assign(f, {
    q: '', status: '', type: '', office: '', officer: '', outcome: '', client: '', confidential: false, from: '', to: '',
  });
}

const summary = computed(() => (chips.value.length ? `${matching.value.length.toLocaleString('en-GB')} of ${plural(total, 'case')}` : plural(total, 'case')));
// Screen readers hear the count once typing pauses, not after every letter.
const announced = ref('');
let sayTimer = 0;
watch(() => matching.value.length, (n) => {
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => { announced.value = `${plural(n, 'case')} ${chips.value.length ? 'match' : 'in the list'}`; }, 700);
});
</script>

<template>
  <div class="page-head">
    <div><h1>Cases</h1><p class="sub">All case files across offices</p></div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-secondary" type="button" @click="print"><i class="bi bi-printer" aria-hidden="true"></i> Print</button>
      <a class="btn btn-outline-secondary" :href="csvHref"><i class="bi bi-download" aria-hidden="true"></i> Export CSV</a>
      <a class="btn btn-primary" href="/cases/new"><i class="bi bi-plus-lg" aria-hidden="true"></i> New case</a>
    </div>
  </div>

  <form class="filters d-print-none" role="search" @submit.prevent>
    <div class="search-box grow">
      <i class="bi bi-search" aria-hidden="true"></i>
      <input v-model="f.q" class="form-control" type="search" name="q" placeholder="Search heading, case number, complaint" aria-label="Search cases" autocomplete="off">
    </div>
    <select v-model="f.status" class="form-select" name="status" aria-label="Status">
      <option value="">All statuses</option>
      <option value="open">All open cases</option>
      <option value="concluded">All concluded cases</option>
      <option v-for="s in lists.statuses" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.type" class="form-select" name="type" aria-label="Type of case">
      <option value="">All types</option>
      <option v-for="s in lists.types" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.office" class="form-select" name="office" aria-label="Office">
      <option value="">All offices</option>
      <option v-for="s in lists.offices" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.officer" class="form-select" name="officer" aria-label="Officer">
      <option value="">All officers</option>
      <option value="me">My cases</option>
      <option v-for="o in d.officers" :key="o.id" :value="o.id">{{ o.name }}</option>
    </select>
    <select v-model="f.outcome" class="form-select" name="outcome" aria-label="Outcome">
      <option value="">Any outcome</option>
      <option v-for="s in lists.outcomes" :key="s" :value="s">{{ s }}</option>
    </select>
    <div class="form-check ms-1">
      <input id="f-conf" v-model="f.confidential" class="form-check-input" type="checkbox" name="confidential">
      <label class="form-check-label" for="f-conf">Confidential only</label>
    </div>
  </form>

  <div class="results-bar">
    <p class="results-count">
      <strong>{{ summary }}</strong>
      <span v-if="searching" class="results-note"><span class="spinner-dot" aria-hidden="true"></span>Searching the complaints too</span>
      <span v-else-if="failed" class="results-note text-warning-emphasis">Could not search the complaints; these match headings and case numbers</span>
    </p>
    <FilterChips :chips="chips" @remove="remove" @clear="clear" />
  </div>
  <p class="print-summary d-none d-print-block">{{ summary }}<template v-if="chips.length">: {{ chips.map((c) => c.label).join('; ') }}</template></p>
  <p class="visually-hidden" aria-live="polite">{{ announced }}</p>

  <div v-if="!total" class="panel"><div class="empty"><i class="bi bi-folder2-open" aria-hidden="true"></i>No cases yet. <a href="/cases/new">Open a new case</a>.</div></div>
  <div v-else-if="!rows.length" class="panel">
    <div class="empty"><i class="bi bi-search" aria-hidden="true"></i>No cases match these filters.
      <button type="button" class="btn btn-link p-0 align-baseline" @click="clear">Clear the filters</button></div>
  </div>
  <div v-else class="table-wrap">
    <table class="table table-hover align-middle live-table">
      <thead>
        <tr>
          <SortHeader class="d-none d-md-table-cell" label="Case no." field="no" :sort="sort" @sort="sortBy" />
          <SortHeader label="Heading" field="heading" :sort="sort" @sort="sortBy" />
          <th>Client</th>
          <th class="d-none d-lg-table-cell">Other party</th>
          <SortHeader label="Status" field="status" :sort="sort" @sort="sortBy" />
          <SortHeader class="d-none d-md-table-cell" label="Office" field="office" :sort="sort" @sort="sortBy" />
          <SortHeader class="d-none d-xl-table-cell" label="Officer" field="officer" :sort="sort" @sort="sortBy" />
          <SortHeader class="d-none d-md-table-cell" label="Updated" field="updated" :sort="sort" @sort="sortBy" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in rows" :key="c.id">
          <td class="nowrap d-none d-md-table-cell"><a :href="`/cases/${c.id}`">{{ c.no }}</a></td>
          <td class="cell-main">
            <a class="cell-strong" :href="`/cases/${c.id}`">{{ c.heading }}</a>
            <template v-if="c.restricted"><i class="bi bi-lock-fill text-warning ms-1" title="Confidential case" aria-hidden="true"></i><span class="visually-hidden">(confidential)</span></template>
            <div class="small text-body-secondary d-md-none">{{ c.no }}</div>
            <div><span v-for="t in c.types" :key="t" class="tag">{{ t }}</span></div>
          </td>
          <td><template v-for="([id, name], i) in c.clientLinks" :key="id">{{ i ? ', ' : '' }}<a :href="`/people/clients/${id}`">{{ name }}</a></template></td>
          <td class="d-none d-lg-table-cell"><template v-for="([id, name], i) in c.otherLinks" :key="id">{{ i ? ', ' : '' }}<a :href="`/people/defendants/${id}`">{{ name }}</a></template></td>
          <td><span class="badge badge-status" :class="`text-bg-${c.badge}`">{{ c.status }}</span><div v-if="c.outcome" class="small text-body-secondary">{{ c.outcome }}</div></td>
          <td class="d-none d-md-table-cell">{{ c.office }}</td>
          <td class="d-none d-xl-table-cell">{{ officerNames.get(c.officerId) || '' }}</td>
          <td class="d-none d-md-table-cell nowrap">{{ c.updatedLabel }}<div class="small text-body-secondary">Opened {{ c.openedLabel }}</div></td>
        </tr>
      </tbody>
    </table>
  </div>
  <ShowMore :shown="rows.length" :total="sorted.length" :step="step" @more="more" @all="showAll" />
</template>
