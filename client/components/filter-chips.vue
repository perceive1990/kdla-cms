<script setup>
// The filters in use, each with a button to remove it, and one to remove them all.
defineProps({ chips: { type: Array, required: true } });
const emit = defineEmits(['remove', 'clear']);
</script>

<template>
  <div v-if="chips.length" class="chips d-print-none">
    <button v-for="c in chips" :key="c.key" type="button" class="chip" :title="`Remove: ${c.label}`" @click="emit('remove', c.key)">
      <span>{{ c.label }}</span><i class="bi bi-x-lg" aria-hidden="true"></i><span class="visually-hidden">(remove this filter)</span>
    </button>
    <button v-if="chips.length > 1" type="button" class="chip-clear" @click="emit('clear')">Clear all</button>
  </div>
</template>
