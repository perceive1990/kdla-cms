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

// ---------- Register names ----------
// Every register carries a short reference, printed on each page and used to name its signed scans on the
// activity report, so a pile of signed sheets is quickly matched to its activity. For example REG-FIS-2610-A03:
// Fisenge Office, the work plan starting October 2026, planned activity 3.

/** "Fisenge Office" → FIS, "Kitwe Main Office" → KM, "Chief Nkana Office" → CN. */
function officeCode(office) {
  const words = String(office || '').replace(/\boffice\b/gi, ' ').split(/[^A-Za-z]+/).filter(Boolean);
  if (!words.length) return 'KDLA';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((w) => w[0]).join('').slice(0, 4).toUpperCase();
}

const yymm = (d) => (/^\d{4}-\d{2}/.test(String(d || '')) ? `${d.slice(2, 4)}${d.slice(5, 7)}` : '0000');

/** The reference of the register of a planned activity. */
function planCode(plan, item) {
  const n = Number.isInteger(item.number) ? String(item.number).padStart(2, '0') : String(item.id).slice(0, 4).toUpperCase();
  return `REG-${officeCode(plan.office)}-${yymm(plan.periodStart)}-A${n}`;
}

/** A report's register: its planned activity's reference, else one made from the office, date and report. */
function reportCode(r, plan, item, office) {
  if (plan && item) return planCode(plan, item);
  const d = String(r.date || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(2).replace(/-/g, '') : '000000';
  return `REG-${officeCode(office || r.office)}-${day}-R${String(r.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()}`;
}

/** "REG-FIS-2610-A03 2026-10-05 signed register 2.pdf" */
function scanName(code, date, k, original) {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(String(original || '')) || [])[1];
  return `${code}${/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? ` ${date}` : ''} signed register ${k}${ext ? `.${ext.toLowerCase()}` : ''}`;
}

module.exports = {
  officeCode, planCode, reportCode, scanName,
  FIRST_PAGE, NEXT_PAGES, MAX_LINES, lineCount, pages,
};
