<script setup>
// The four counts at the top of the dashboard. They refresh while the page is in use, and a count that
// changed is lit up briefly so the change is noticed.
import { computed, reactive, watch } from 'vue';

const props = defineProps({ source: { type: Object, required: true } });
props.source.keepFresh();
const stats = computed(() => props.source.state.data.stats);

const changed = reactive({});
watch(() => ({ ...stats.value }), (now, before) => {
  for (const key of Object.keys(now)) {
    if (before && now[key] !== before[key]) {
      changed[key] = false;
      window.requestAnimationFrame(() => { changed[key] = true; });
      window.setTimeout(() => { changed[key] = false; }, 2400);
    }
  }
});

const tiles = [
  {
    key: 'mine', label: 'My open cases', href: '/cases?officer=me&status=open', icon: 'bi-folder2-open',
  },
  {
    key: 'overdue', label: 'My overdue tasks', href: '/tasks', icon: 'bi-alarm', alert: true,
  },
  {
    key: 'open', label: 'All open cases', href: '/cases?status=open', icon: 'bi-briefcase',
  },
  {
    key: 'openReferrals', label: 'Referrals needing follow up', href: '/referrals?followUp=Needs+follow+up', icon: 'bi-arrow-left-right',
  },
];
</script>

<template>
  <div v-for="t in tiles" :key="t.key" class="col-6 col-lg-3">
    <a class="stat" :class="{ 'alert-stat': t.alert && stats[t.key] > 0, 'is-changed': changed[t.key] }" :href="t.href">
      <span class="stat-icon" aria-hidden="true"><i class="bi" :class="t.icon"></i></span>
      <div class="label">{{ t.label }}</div>
      <div class="value">{{ stats[t.key] }}</div>
    </a>
  </div>
</template>
