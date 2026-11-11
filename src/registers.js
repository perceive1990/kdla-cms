'use strict';
// Printable attendance registers (sign-in sheets) for meetings and other activities, on landscape A4.
// The first page carries the activity details, so it holds fewer lines than the pages after it. The
// columns follow the attendance register form, so a filled sheet is quick to type in afterwards.
const FIRST_PAGE = 10;
const NEXT_PAGES = 15;
const MAX_LINES = 402;

/** Lines that fill whole pages, at least `want`. */
function roundUp(want) {
  if (want <= FIRST_PAGE) return FIRST_PAGE;
  return FIRST_PAGE + Math.ceil((want - FIRST_PAGE) / NEXT_PAGES) * NEXT_PAGES;
}

/**
 * How many lines to print: what was asked for, else the people expected at one session of the
 * activity (people to reach shared over the number of times it is held), else 25 (two pages).
 */
function lineCount(asked, { people = 0, times = 1 } = {}) {
  const n = Number.parseInt(asked, 10);
  let want = 25;
  if (Number.isInteger(n) && n > 0) want = n;
  else if (Number(people) > 0) want = Math.min(150, Math.ceil(Number(people) / Math.max(1, Number(times) || 1)));
  return Math.min(MAX_LINES, roundUp(want));
}

/** Splits the lines into pages; names already registered (when asked for) fill the first lines. */
function pages(total, names = []) {
  const count = Math.min(MAX_LINES, Math.max(total, roundUp(names.length)));
  const lines = Array.from({ length: count }, (_, i) => names[i] || null);
  const out = [lines.slice(0, FIRST_PAGE)];
  for (let i = FIRST_PAGE; i < lines.length; i += NEXT_PAGES) out.push(lines.slice(i, i + NEXT_PAGES));
  return out;
}

module.exports = {
  FIRST_PAGE, NEXT_PAGES, MAX_LINES, lineCount, pages,
};
