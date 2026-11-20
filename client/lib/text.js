// Small text helpers shared by the live screens.

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export const money = (n) => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The search term as the server reads it: trimmed and at most 80 characters. */
export const searchTerm = (q) => String(q || '').trim().slice(0, 80);

/** Case-insensitive "contains", as the server's search. */
export const contains = (value, term) => String(value ?? '').toLowerCase().includes(term.toLowerCase());

/** YYYY-MM-DD that is a real date. */
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** 2026-11-05 as 05 Nov 2026. */
export const dateLabel = (s) => (isDate(s) ? dateFmt.format(new Date(`${s}T00:00:00Z`)) : s);

const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });
const empty = (v) => v === '' || v === null || v === undefined;

/** Compare two values: numbers as numbers, text (and case numbers such as KDLA/2026/0012) in a natural order. */
export function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** A sorted copy of the rows by get(row), ascending or descending; rows without a value always come last. */
export function sortRows(rows, get, dir, tie = () => 0) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = get(x); const b = get(y);
    if (empty(a) || empty(b)) return empty(a) === empty(b) ? tie(x, y) : (empty(a) ? 1 : -1);
    return sign * compare(a, b) || tie(x, y);
  });
}
