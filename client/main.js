// Live screens (Vue). The server marks parts of a page with data-vue="name" and data-src="address of the data".
// Each part is swapped for its live screen as soon as that data has arrived. Until then, and if anything fails
// (an old browser, no connection, an error), the version the server drew stays and works as before.
const SCREENS = {
  cases: () => import('./screens/cases-list.vue'),
  tasks: () => import('./screens/tasks-list.vue'),
  reports: () => import('./screens/reports-list.vue'),
  'dash-stats': () => import('./screens/dash-stats.vue'),
  'dash-tasks': () => import('./screens/dash-tasks.vue'),
  'dash-recent': () => import('./screens/dash-recent.vue'),
  'dash-hearings': () => import('./screens/dash-hearings.vue'),
};

/** Words typed into a search box before the live screen arrived, so they are not lost. */
function typedIn(el) {
  const out = {};
  el.querySelectorAll('input[type="search"][name]').forEach((input) => { out[input.name] = input.value; });
  return out;
}

/** Keep the cursor in the same box (and place) when the live screen replaces the server's version. */
function keepFocus(el) {
  const active = document.activeElement;
  if (!active || !el.contains(active) || !active.name) return () => {};
  const { name } = active;
  let range = null;
  try { range = [active.selectionStart, active.selectionEnd]; } catch (e) { /* not a text box */ }
  return () => {
    const box = [...el.querySelectorAll('[name]')].find((x) => x.name === name);
    if (!box) return;
    box.focus();
    if (range && range[0] !== null) {
      try { box.setSelectionRange(range[0], range[1]); } catch (e) { /* not a text box */ }
    }
  };
}

async function start() {
  const spots = [...document.querySelectorAll('[data-vue][data-src]')].filter((el) => SCREENS[el.dataset.vue]);
  // A list opened to print every record (?print=1) stays as the server drew it.
  if (!spots.length || new URLSearchParams(location.search).get('print') === '1') return;
  const [{ createApp }, { feed }] = await Promise.all([import('vue'), import('./lib/feed.js')]);
  await Promise.all(spots.map(async (el) => {
    try {
      const source = feed(el.dataset.src);
      const [screen] = await Promise.all([SCREENS[el.dataset.vue](), source.ready()]);
      const typed = typedIn(el);
      const restoreFocus = keepFocus(el);
      const serverVersion = document.createDocumentFragment();
      serverVersion.append(...el.childNodes);
      let mounted = false;
      let failed = false;
      const app = createApp(screen.default, { source, typed });
      app.config.errorHandler = (err) => {
        if (!mounted) failed = true;
        console.error(err);
      };
      try { app.mount(el); } catch (err) { failed = true; console.error(err); }
      mounted = true;
      if (failed) {
        try { app.unmount(); } catch (e) { /* already gone */ }
        el.replaceChildren(serverVersion);
        return;
      }
      el.dataset.vueReady = '1';
      restoreFocus();
    } catch (err) {
      console.warn(`The live ${el.dataset.vue} screen did not start; the page works as before.`, err);
    }
  }));
  document.documentElement.dataset.liveScreens = 'ready';
}

start();
