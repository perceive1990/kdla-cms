// The filters of a live list are kept in the address bar, so a filtered list can be bookmarked, shared or
// opened again with the browser's back button, exactly like the lists the server draws.

/** The current value of each named parameter ('' when absent). */
export function readParams(names) {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(names.map((n) => [n, p.get(n) || '']));
}

/** Query string for the given values, leaving out empty ones. */
export function toQuery(values) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== '' && v !== null && v !== undefined && v !== false) p.set(k, String(v));
  return p.toString();
}

/** Show the values in the address bar without reloading the page. */
export function writeParams(values) {
  const qs = toQuery(values);
  const next = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, '', next);
}
