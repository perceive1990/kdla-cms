// Search as you type. Matches in the short fields the browser already has (heading, case number) show at once;
// the server is asked as well, after a short pause in typing, because its search also reads the long text
// (a case's complaint, a report's introduction and objectives) that is not sent to the browser. Its matches are
// added when they arrive, so the list ends up exactly as the printout and the CSV export.
import { ref, watch } from 'vue';
import { getJson } from './http.js';
import { searchTerm } from './text.js';

export function useServerSearch(base, query, { wait = 300 } = {}) {
  const ids = ref(new Set());
  const searching = ref(false);
  const failed = ref(false);
  let timer = 0;
  let seq = 0;
  watch(() => searchTerm(query.value), (term) => {
    window.clearTimeout(timer);
    seq += 1;
    const mine = seq;
    ids.value = new Set();
    failed.value = false;
    if (!term) { searching.value = false; return; }
    searching.value = true;
    timer = window.setTimeout(async () => {
      try {
        const res = await getJson(`${base}?q=${encodeURIComponent(term)}`);
        if (mine === seq) ids.value = new Set(res.ids || []);
      } catch (e) {
        if (mine === seq) failed.value = true;
      } finally {
        if (mine === seq) searching.value = false;
      }
    }, wait);
  }, { immediate: true });
  return { ids, searching, failed };
}
