<script setup>
// My tasks for the next two weeks, on the dashboard. Ticking one off saves it at once and takes it off the
// list, with Undo; the overdue count at the top and in the menu follow.
import { computed, nextTick, reactive, ref } from 'vue';
import ToastLine from '../components/toast-line.vue';
import { postForm } from '../lib/http.js';
import { setOverdueBadge } from '../lib/menu.js';
import { useToast, readOnly } from '../lib/toast.js';

const props = defineProps({ source: { type: Object, required: true } });
props.source.keepFresh();
const { state } = props.source;
const tasks = computed(() => state.data.myTasks);
const canTick = !readOnly();
const { toast, show, hide } = useToast();
const leaving = reactive(new Set());
const root = ref(null);

const wait = (ms) => new Promise((done) => { window.setTimeout(done, ms); });
const quiet = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Put the keyboard focus on the next task (or the heading) after a row goes away. */
function focusAfter(index) {
  nextTick(() => {
    if (!root.value) return;
    const buttons = root.value.querySelectorAll('[data-tick]');
    const target = buttons[Math.min(index, buttons.length - 1)] || root.value.querySelector('.panel-title');
    if (target) target.focus();
  });
}

async function undo(t) {
  hide();
  try {
    const res = await postForm(`/tasks/${encodeURIComponent(t.id)}/done`, { done: 'false' });
    setOverdueBadge(res.overdue);
    await props.source.load();
  } catch (e) {
    show(e.message, { error: true });
  }
}

async function done(t, event) {
  if (leaving.has(t.id)) return;
  const hadFocus = event && event.currentTarget === document.activeElement;
  leaving.add(t.id);
  try {
    const res = await postForm(`/tasks/${encodeURIComponent(t.id)}/done`, { done: 'true' });
    if (!quiet()) await wait(220);
    const list = state.data.myTasks;
    const at = list.findIndex((x) => x.id === t.id);
    if (at >= 0) list.splice(at, 1);
    state.data.stats.overdue = res.overdue;
    setOverdueBadge(res.overdue);
    show(`Done: ${t.title}`, { action: { label: 'Undo', run: () => undo(t) } });
    if (hadFocus) focusAfter(Math.max(at, 0));
  } catch (e) {
    show(e.message, { error: true });
  } finally {
    leaving.delete(t.id);
  }
}
</script>

<template>
  <div ref="root" class="panel-body">
    <div class="panel-head">
      <h2 class="panel-title" tabindex="-1">My tasks for the next two weeks</h2>
      <a class="small" href="/tasks/new">Add task</a>
    </div>
    <p v-if="!tasks.length" class="text-body-secondary mb-0">Nothing due. Add hearings, mediation sessions and deadlines from a case page so nothing is missed.</p>
    <div v-for="t in tasks" :key="t.id" class="task-row" :class="{ 'is-leaving': leaving.has(t.id) }">
      <div class="when" :class="{ 'text-danger fw-semibold': t.overdue }">{{ t.when }}<div v-if="t.overdue" class="small">Overdue</div></div>
      <div class="grow">
        <div class="title"><span class="tag tag-muted">{{ t.type }}</span> {{ t.title }}</div>
        <div v-if="t.caseId" class="small"><a :href="`/cases/${t.caseId}`">{{ t.caseLabel }}</a></div>
      </div>
      <button v-if="canTick" type="button" class="btn btn-sm btn-outline-primary tick-btn" data-tick title="Mark done"
              :aria-disabled="leaving.has(t.id) ? 'true' : null" @click="done(t, $event)">
        <i class="bi bi-check2" aria-hidden="true"></i><span class="visually-hidden">Mark {{ t.title }} done</span>
      </button>
    </div>
  </div>
  <ToastLine :toast="toast" />
</template>
