'use strict';
const crypto = require('crypto');
const config = require('./config');

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Always return an array from a form field (checkboxes / multi-selects). */
function arr(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

/** Checkbox or JSON boolean: "on", "true", "1", true. */
function bool(v) {
  return v === true || v === 1 || v === 'on' || v === 'true' || v === '1';
}

function str(v, max = 5000) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function intOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: config.displayTimeZone, day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.displayTimeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.displayTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in the display time zone, as YYYY-MM-DD. */
function today(offsetDays = 0) {
  return ymdFmt.format(new Date(Date.now() + offsetDays * 86400000));
}

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-31). */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole days from a to b (YYYY-MM-DD or ISO strings). */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00Z`);
  const dbb = new Date(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(dbb.getTime())) return null;
  return Math.round((dbb - da) / 86400000);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dateFmt.format(d);
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dateTimeFmt.format(d);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fullName(p) {
  return p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : '';
}

function statusBadge(status) {
  if (!status) return 'secondary';
  if (status.startsWith('Concluded')) return 'secondary';
  if (status.includes('Referred')) return 'info';
  if (status.includes('Inactive')) return 'warning';
  return 'success';
}

/** Build an id -> doc map for a list of ids from one container. */
async function mapByIds(db, container, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return {};
  const out = {};
  // Chunk to keep the query parameter small.
  for (let i = 0; i < unique.length; i += 100) {
    const rows = await db.find(container, { where: { id: { $in: unique.slice(i, i + 100) } } });
    for (const r of rows) out[r.id] = r;
  }
  return out;
}

function pagination(req, total) {
  const pageSize = config.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
  const qs = (p) => {
    const params = new URLSearchParams({ ...req.query, page: String(p) });
    return `?${params.toString()}`;
  };
  return { page, pages, total, pageSize, offset: (page - 1) * pageSize, qs };
}

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    let s = Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map((h) => esc(h.label)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(typeof h.value === 'function' ? h.value(r) : r[h.value])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

/** Tally values (strings or arrays of strings) into [{label, count}] sorted by count. */
function tally(rows, field, order) {
  const counts = {};
  for (const r of rows) {
    const vals = Array.isArray(r[field]) ? r[field] : [r[field]];
    for (const v of vals) {
      const k = v || 'Not recorded';
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  const out = Object.entries(counts).map(([label, count]) => ({ label, count }));
  if (order) {
    out.sort((a, b) => {
      const ia = order.indexOf(a.label); const ib = order.indexOf(b.label);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  } else {
    out.sort((a, b) => b.count - a.count);
  }
  return out;
}

function plural(n, word, many) {
  return `${n} ${n === 1 ? word : (many || `${word}s`)}`;
}

module.exports = {
  newId, now, arr, str, bool, intOrNull, fmtDate, fmtDateTime, fmtBytes, fullName, statusBadge,
  mapByIds, pagination, toCsv, sendCsv, tally, today, isRealDate, daysBetween, plural,
};
