// Printing a live list prints every row that matches the filters, not only the rows shown on screen.
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue';

export function usePrintAll() {
  const printing = ref(false);
  const before = () => { printing.value = true; };
  const after = () => { printing.value = false; };
  onMounted(() => {
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  });
  async function print() {
    printing.value = true;
    await nextTick();
    window.print();
  }
  return { printing, print };
}
