<script setup>
// Recently updated cases on the dashboard, refreshed while the page is in use.
import { computed } from 'vue';

const props = defineProps({ source: { type: Object, required: true } });
props.source.keepFresh();
const recent = computed(() => props.source.state.data.recent);
</script>

<template>
  <div class="panel-body">
    <div class="panel-head">
      <h2 class="panel-title">Recently updated cases</h2>
      <a href="/cases" class="small">All cases</a>
    </div>
    <div v-if="!recent.length" class="empty"><i class="bi bi-folder2-open" aria-hidden="true"></i>No cases yet. <a href="/cases/new">Open the first case</a>.</div>
    <div v-else class="table-responsive">
      <table class="table table-hover align-middle dash-cases">
        <thead><tr><th>Case</th><th>Client</th><th>Status</th><th class="d-none d-md-table-cell">Officer</th><th class="d-none d-md-table-cell">Updated</th></tr></thead>
        <tbody>
          <tr v-for="c in recent" :key="c.id">
            <td>
              <a class="cell-strong" :href="`/cases/${c.id}`">{{ c.heading }}</a>
              <template v-if="c.restricted"><i class="bi bi-lock-fill text-warning ms-1" title="Confidential" aria-hidden="true"></i><span class="visually-hidden">(confidential)</span></template>
              <div class="text-body-secondary small">{{ c.no }}</div>
            </td>
            <td>{{ c.clients }}</td>
            <td><span class="badge badge-status" :class="`text-bg-${c.badge}`">{{ c.status }}</span></td>
            <td class="d-none d-md-table-cell">{{ c.officer }}</td>
            <td class="d-none d-md-table-cell nowrap">{{ c.updated }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
