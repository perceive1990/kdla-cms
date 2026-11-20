<script setup>
// A column heading that sorts the list: press once to sort by the column, again to reverse.
defineProps({
  label: { type: String, required: true },
  field: { type: String, required: true },
  sort: { type: Object, required: true },
  end: { type: Boolean, default: false },
});
const emit = defineEmits(['sort']);
</script>

<template>
  <th :aria-sort="sort.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined" :class="{ 'text-end': end }">
    <button type="button" class="th-sort" :class="{ 'is-on': sort.field === field }" @click="emit('sort', field)">
      <span>{{ label }}</span>
      <i class="bi" :class="sort.field !== field ? 'bi-arrow-down-up' : (sort.dir === 'asc' ? 'bi-arrow-up' : 'bi-arrow-down')" aria-hidden="true"></i>
    </button>
  </th>
</template>
