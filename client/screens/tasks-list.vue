<script setup>
// Tasks and hearings, live. Ticking a task saves it at once (with Undo) and keeps the overdue count in the menu
// right. Whose tasks, and To do or Completed, come from the server; the type and the search words narrow the
// list at once.
import { computed, reactive, ref, watch } from 'vue';
import ToastLine from '../components/toast-line.vue';
import { readParams, writeParams, toQuery } from '../lib/address.js';
import { postForm } from '../lib/http.js';
import { setOverdueBadge } from '../lib/menu.js';
import { useToast, readOnly } from '../lib/toast.js';
import { contains, searchTerm } from '../lib/text.js';

const props = defineProps({
  source: { type: Object, required: true },
  typed: { type: Object, default: () => ({}) },
});

const { state } = props.source;
const d = computed(() => state.data);
const canTick = !readOnly();
const { toast, show, hide } = useToast();

const start = readParams(['type', 'q']);
const f = reactive({
  who: state.data.who,
  show: state.data.show,
  type: state.data.types.includes(start.type) ? start.type : '',
  q: props.typed.q ?? start.q,
});

// Whose tasks and which ones come from the server: ask again when they change.
watch(() => [f.who, f.show], ([who, which]) => {
  props.source.load(`/tasks/data?${toQuery({ who, show: which })}`).catch((e) => {
    if (e.name !== 'AbortError') show(e.message, { error: true });
  });
});

const term = computed(() => searchTerm(f.q));
let addressTimer = 0;
watch(() => [f.who, f.show, f.type, term.value], () => {
  window.clearTimeout(addressTimer);
  addressTimer = window.setTimeout(() => writeParams({
    who: f.who === 'me' ? '' : f.who, show: f.show === 'open' ? '' : f.show, type: f.type, q: term.value,
  }), 250);
});

const searched = (t) => [t.title, t.type, t.location, t.notes, t.assignee, t.case && t.case.no, t.case && t.case.heading].some((v) => contains(v, term.value));
const visible = computed(() => d.value.tasks.filter((t) => (!f.type || t.type === f.type) && (!term.value || searched(t))));
const groups = computed(() => {
  const list = visible.value;
  if (d.value.show === 'done') return [{ key: 'done', label: 'Completed', items: list }];
  const t0 = d.value.today;
  const t7 = d.value.week;
  return [
    {
      key: 'overdue', label: 'Overdue', tone: 'danger', items: list.filter((t) => t.due < t0),
    },
    { key: 'today', label: 'Today', items: list.filter((t) => t.due === t0) },
    { key: 'week', label: 'Next 7 days', items: list.filter((t) => t.due > t0 && t.due <= t7) },
    { key: 'later', label: 'Later', items: list.filter((t) => t.due > t7) },
  ].filter((g) => g.items.length);
});
const left = (g) => (d.value.show === 'done' ? g.items.filter((t) => t.done).length : g.items.filter((t) => !t.done).length);
const ticked = (g) => g.items.length - left(g);

const busy = reactive(new Set());
async function toggle(t) {
  if (busy.has(t.id)) return;
  const next = !t.done;
  t.done = next;
  busy.add(t.id);
  try {
    const res = await postForm(`/tasks/${encodeURIComponent(t.id)}/done`, { done: next ? 'true' : 'false' });
    setOverdueBadge(res.overdue);
    show(`${next ? 'Done' : 'Back on the list'}: ${t.title}`, { action: { label: 'Undo', run: () => { hide(); toggle(t); } } });
  } catch (e) {
    t.done = !next;
    show(e.message, { error: true });
  } finally {
    busy.delete(t.id);
  }
}

const clear = () => { f.type = ''; f.q = ''; };
const caseText = (c) => `${c.no}${c.heading ? ` ${c.heading}` : ''}`;
const emptyText = computed(() => (d.value.show === 'done' ? 'Nothing completed yet.' : 'Nothing to do. Add hearings and deadlines from a case page or with the button above.'));
const print = () => window.print();
const announced = ref('');
let sayTimer = 0;
watch(() => visible.value.length, (n) => {
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => { announced.value = `${n} ${n === 1 ? 'task' : 'tasks'} shown`; }, 700);
});
</script>

<template>
  <div class="page-head">
    <div><h1>Tasks and hearings</h1><p class="sub">Deadlines, court hearings, mediation sessions and follow ups</p></div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-secondary" type="button" @click="print"><i class="bi bi-printer" aria-hidden="true"></i> Print</button>
      <a class="btn btn-primary" href="/tasks/new"><i class="bi bi-plus-lg" aria-hidden="true"></i> New task or hearing</a>
    </div>
  </div>

  <form class="filters d-print-none" role="search" @submit.prevent>
    <div class="search-box grow">
      <i class="bi bi-search" aria-hidden="true"></i>
      <input v-model="f.q" class="form-control" type="search" name="q" placeholder="Search tasks, places, people, cases" aria-label="Search tasks" autocomplete="off">
    </div>
    <select v-model="f.who" class="form-select" name="who" aria-label="Whose tasks">
      <option value="me">My tasks</option>
      <option value="all">Everyone's tasks</option>
      <option v-for="u in d.users" :key="u.id" :value="u.id">{{ u.name }}</option>
    </select>
    <select v-model="f.type" class="form-select" name="type" aria-label="Type">
      <option value="">All types</option>
      <option v-for="t in d.types" :key="t" :value="t">{{ t }}</option>
    </select>
    <select v-model="f.show" class="form-select" name="show" aria-label="Status">
      <option value="open">To do</option>
      <option value="done">Completed</option>
    </select>
  </form>
  <p class="visually-hidden" aria-live="polite">{{ announced }}</p>

  <div class="live-list" :class="{ 'is-busy': state.busy }" :aria-busy="state.busy ? 'true' : 'false'">
    <div v-if="!d.tasks.length" class="panel"><div class="empty"><i class="bi bi-calendar-check" aria-hidden="true"></i>{{ emptyText }}</div></div>
    <div v-else-if="!visible.length" class="panel">
      <div class="empty"><i class="bi bi-search" aria-hidden="true"></i>No tasks match.
        <button type="button" class="btn btn-link p-0 align-baseline" @click="clear">Show them all</button></div>
    </div>
    <div v-for="g in groups" :key="g.key" class="panel">
      <div class="panel-body">
        <h2 class="panel-title" :class="{ 'text-danger': g.tone === 'danger' }">{{ g.label }} ({{ left(g) }})<span v-if="ticked(g)" class="group-note">{{ ticked(g) }} {{ d.show === 'done' ? 'back on the list' : 'done' }}</span></h2>
        <div v-for="t in g.items" :key="t.id" class="task-row" :class="{ done: t.done }">
          <button v-if="canTick" type="button" class="btn btn-sm tick-btn" :class="t.done ? 'btn-primary' : 'btn-outline-primary'" :aria-pressed="t.done ? 'true' : 'false'"
                  :aria-disabled="busy.has(t.id) ? 'true' : null" :title="t.done ? 'Mark not done' : 'Mark done'" @click="toggle(t)">
            <i class="bi bi-check2" aria-hidden="true"></i><span class="visually-hidden">Done: {{ t.title }}</span>
          </button>
          <div class="when">{{ t.dueLabel }}<div class="small text-body-secondary">{{ t.time }}</div></div>
          <div class="grow">
            <div class="title"><span class="tag tag-muted">{{ t.type }}</span> {{ t.title }}</div>
            <div class="small text-body-secondary">
              {{ t.assignee }}<template v-if="t.location"> · {{ t.location }}</template><template v-if="t.case"> · <a :href="`/cases/${t.case.id}`">{{ caseText(t.case) }}</a></template>
            </div>
            <div v-if="t.notes" class="small prose">{{ t.notes }}</div>
          </div>
          <div class="small text-nowrap">
            <a :href="`/tasks/${t.id}/calendar.ics`" title="Download for your phone or Outlook calendar"><i class="bi bi-calendar-plus" aria-hidden="true"></i><span class="visually-hidden">Add to calendar</span></a>
            <a class="ms-2" :href="`/tasks/${t.id}/edit`">Edit</a>
          </div>
        </div>
      </div>
    </div>
  </div>
  <ToastLine :toast="toast" />
</template>
