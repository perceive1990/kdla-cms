<script setup>
// Long lists show one page of rows at a time; these buttons add the next page, or every row.
import { computed } from 'vue';

const props = defineProps({
  shown: { type: Number, required: true },
  total: { type: Number, required: true },
  step: { type: Number, required: true },
});
const emit = defineEmits(['more', 'all']);
const next = computed(() => Math.min(props.step, props.total - props.shown));
</script>

<template>
  <div v-if="total > shown" class="show-more d-print-none">
    <span class="small text-body-secondary">Showing {{ shown.toLocaleString('en-GB') }} of {{ total.toLocaleString('en-GB') }}</span>
    <button type="button" class="btn btn-outline-primary btn-sm" @click="emit('more')">Show {{ next }} more</button>
    <button type="button" class="btn btn-link btn-sm" @click="emit('all')">Show all</button>
  </div>
</template>
