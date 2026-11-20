// A feed is the JSON a screen shows, loaded from one address and kept in a reactive object, so every part of a
// page that uses the same address (the four live parts of the dashboard) shares one copy and one request.
import { reactive } from 'vue';
import { getJson } from './http.js';

const shared = new Map();

function create(url) {
  const state = reactive({
    url, data: null, busy: false, error: '', at: 0,
  });
  let seq = 0;
  let controller = null;
  let first = null;

  /** Load (or load again) from the feed's address, or from a new one (other filters). The newest request wins. */
  async function load(next = state.url) {
    seq += 1;
    const mine = seq;
    if (controller) controller.abort();
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.busy = true;
    try {
      const data = await getJson(next, { signal: controller ? controller.signal : undefined });
      if (mine === seq) {
        state.data = data;
        state.url = next;
        state.at = Date.now();
        state.error = '';
      }
      return data;
    } catch (e) {
      if (mine === seq && e.name !== 'AbortError') state.error = e.message;
      throw e;
    } finally {
      if (mine === seq) state.busy = false;
    }
  }

  let live = false;
  /**
   * Refresh every `every` milliseconds while the page is open and someone is using it. A page left alone
   * stops asking after `idle` milliseconds, so the session still ends on its own as it is meant to.
   */
  function keepFresh({ every = 60000, idle = 180000 } = {}) {
    if (live) return;
    live = true;
    let used = Date.now();
    const mark = () => { used = Date.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
      window.addEventListener(ev, mark, { passive: true, capture: true });
    }
    const stale = () => Date.now() - state.at >= every;
    window.setInterval(() => {
      if (!document.hidden && Date.now() - used < idle && stale() && !state.busy) load().catch(() => {});
    }, 10000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      mark();
      if (stale()) load().catch(() => {});
    });
  }

  return {
    state,
    load,
    keepFresh,
    /** Resolves once the first load has finished, so a screen can appear complete. */
    ready() {
      if (!first) first = load();
      return first;
    },
  };
}

export function feed(url) {
  if (!shared.has(url)) shared.set(url, create(url));
  return shared.get(url);
}
