<script setup>
// The message area for useToast(): always in the page, so screen readers announce what appears in it.
defineProps({ toast: { type: Object, required: true } });
</script>

<template>
  <div class="toast-line d-print-none" role="status" aria-live="polite">
    <Transition name="toast">
      <div v-if="toast.text" class="toast-box" :class="{ 'is-error': toast.error }">
        <i class="bi" :class="toast.error ? 'bi-exclamation-circle' : 'bi-check2-circle'" aria-hidden="true"></i>
        <span>{{ toast.text }}</span>
        <button v-if="toast.action" type="button" class="toast-act" @click="toast.action.run()">{{ toast.action.label }}</button>
      </div>
    </Transition>
  </div>
</template>
