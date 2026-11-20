<script setup>
// Hearings and mediation sessions in the next 14 days, refreshed while the dashboard is in use.
import { computed } from 'vue';

const props = defineProps({ source: { type: Object, required: true } });
props.source.keepFresh();
const hearings = computed(() => props.source.state.data.hearings);
const meta = (t) => [t.type, t.location, t.who].filter(Boolean).join(' · ');
</script>

<template>
  <div class="panel-body">
    <div class="panel-head">
      <h2 class="panel-title">Hearings and mediations, next 14 days</h2>
    </div>
    <p v-if="!hearings.length" class="text-body-secondary mb-0">None scheduled.</p>
    <div v-for="t in hearings" :key="t.id" class="task-row">
      <div class="when">{{ t.when }}</div>
      <div class="grow">
        <div>{{ t.title }}</div>
        <div class="small text-body-secondary">{{ meta(t) }}</div>
      </div>
    </div>
  </div>
</template>
