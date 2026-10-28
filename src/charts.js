'use strict';
// Small charts drawn as SVG on the server for the infographic page: they print cleanly, need no
// browser library, and every bar carries its value as a label and a hover tooltip.
// Colours come from CSS (class names), so the chart follows the user's theme and accent colour.

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n || 0).toLocaleString('en-GB');

/** Rounded only at the data end (right side), square at the baseline. */
function hbarPath(x, y, w, h, r) {
  const rr = Math.min(r, w, h / 2);
  if (w <= 0) return '';
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

function vbarPath(x, y, w, h, r) {
  const rr = Math.min(r, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Horizontal bars, one hue, value labels at the end of each bar.
 * items: [{ label, count }]. Rows with 0 are kept so categories are never silently missing.
 */
function hbars(items, { title = '', unit = '', max = 8, labelWidth = 150, width = 520 } = {}) {
  const rows = items.slice(0, max);
  if (!rows.length) return '<p class="small text-body-secondary mb-0">No data for this period.</p>';
  const rowH = 30;
  const barH = 16;
  const valueW = 56;
  const plotW = width - labelWidth - valueW;
  const top = Math.max(1, ...rows.map((r) => r.count));
  const height = rows.length * rowH;
  const parts = rows.map((r, i) => {
    const y = i * rowH;
    const w = Math.round((r.count / top) * plotW);
    const tip = `${r.label}: ${num(r.count)}${unit ? ` ${unit}` : ''}`;
    return `<g class="viz-row"><title>${esc(tip)}</title>
<rect class="viz-hit" x="0" y="${y}" width="${width}" height="${rowH}"/>
<text class="viz-label" x="${labelWidth - 10}" y="${y + rowH / 2}" text-anchor="end" dominant-baseline="central">${esc(r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label)}</text>
<path class="viz-track" d="${hbarPath(labelWidth, y + (rowH - barH) / 2, plotW, barH, 4)}"/>
${w > 0 ? `<path class="viz-bar" d="${hbarPath(labelWidth, y + (rowH - barH) / 2, Math.max(w, 3), barH, 4)}"/>` : ''}
<text class="viz-value" x="${labelWidth + Math.max(w, 0) + 8}" y="${y + rowH / 2}" dominant-baseline="central">${num(r.count)}</text></g>`;
  }).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMinYMin meet">${parts}</svg>`;
}

/** Columns over time (one hue). items: [{ label, count }] in time order. */
function columns(items, { title = '', unit = '', width = 560, height = 200 } = {}) {
  if (!items.length) return '<p class="small text-body-secondary mb-0">No data for this period.</p>';
  const left = 34; const bottom = 26; const topPad = 18;
  const plotW = width - left - 6;
  const plotH = height - bottom - topPad;
  const top = Math.max(1, ...items.map((r) => r.count));
  const step = niceStep(top);
  const axisMax = Math.ceil(top / step) * step;
  const slot = plotW / items.length;
  const barW = Math.max(4, Math.min(28, slot - 6));
  const grid = [];
  for (let v = 0; v <= axisMax; v += step) {
    const y = topPad + plotH - (v / axisMax) * plotH;
    grid.push(`<line class="viz-grid" x1="${left}" x2="${width - 6}" y1="${y}" y2="${y}"/><text class="viz-axis" x="${left - 6}" y="${y}" text-anchor="end" dominant-baseline="central">${num(v)}</text>`);
  }
  const showEvery = Math.ceil(items.length / 12);
  const best = items.reduce((a, b) => (b.count > a.count ? b : a), items[0]);
  const bars = items.map((r, i) => {
    const h = (r.count / axisMax) * plotH;
    const x = left + i * slot + (slot - barW) / 2;
    const y = topPad + plotH - h;
    const tip = `${r.label}: ${num(r.count)}${unit ? ` ${unit}` : ''}`;
    const label = i % showEvery === 0 ? `<text class="viz-axis" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${esc(r.short || r.label)}</text>` : '';
    const value = r === best && r.count > 0 ? `<text class="viz-value" x="${x + barW / 2}" y="${y - 5}" text-anchor="middle">${num(r.count)}</text>` : '';
    return `<g class="viz-row"><title>${esc(tip)}</title><rect class="viz-hit" x="${left + i * slot}" y="${topPad}" width="${slot}" height="${plotH}"/>${h > 0 ? `<path class="viz-bar" d="${vbarPath(x, y, barW, Math.max(h, 2), 4)}"/>` : ''}${value}${label}</g>`;
  }).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMinYMin meet">${grid.join('')}<line class="viz-baseline" x1="${left}" x2="${width - 6}" y1="${topPad + plotH}" y2="${topPad + plotH}"/>${bars}</svg>`;
}

function niceStep(max) {
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const n = rough / pow;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
}

/** A share against 100%: a same-hue track with the filled part. */
function meter(percent, { title = '', width = 240 } = {}) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const w = Math.round((p / 100) * width);
  return `<svg class="viz viz-meter" viewBox="0 0 ${width} 12" role="img" aria-label="${esc(title)}: ${p}%"><title>${esc(title)}: ${p}%</title><rect class="viz-track" x="0" y="0" width="${width}" height="12" rx="6"/>${w > 0 ? `<rect class="viz-bar" x="0" y="0" width="${Math.max(w, 12)}" height="12" rx="6"/>` : ''}</svg>`;
}

/** Month-by-month counts between two YYYY-MM-DD dates (at most 36 months). */
function monthly(dates, from, to) {
  const out = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let d = start; d <= end && out.length < 36; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = d.toISOString().slice(0, 7);
    const m = names[d.getUTCMonth()];
    out.push({ key, label: `${m} ${d.getUTCFullYear()}`, short: m, count: 0 });
  }
  const byKey = Object.fromEntries(out.map((o) => [o.key, o]));
  for (const date of dates) if (date && byKey[String(date).slice(0, 7)]) byKey[String(date).slice(0, 7)].count += 1;
  return out;
}

module.exports = {
  hbars, columns, meter, monthly, num,
};
