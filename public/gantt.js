// Lightweight Gantt renderer (HTML/CSS, no third-party library) used by both views.
// Server returns pre-aggregated rows, so rendering needs no further queries.
import { esc, addDays, diffDays, parseD, fmtD, mondayOf } from './util.js';

const PX = { day: 38, week: 16, month: 4 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoWeek(s) {
  const d = new Date(parseD(s)); const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}

function headerCells(from, to, zoom, px) {
  const cells = [];
  let d = from;
  while (d <= to) {
    let end; let label;
    if (zoom === 'day') { end = d; const dt = new Date(parseD(d)); label = `${DOW[dt.getUTCDay()]} ${d.slice(8)}`; }
    else if (zoom === 'week') { end = addDays(d, 6); label = `W${isoWeek(d)} · ${d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`; }
    else { const [y, m] = d.split('-').map(Number); end = fmtD(Date.UTC(y, m, 0)); label = `${MONTHS[m - 1]} ${y}`; }
    const dt = new Date(parseD(d)).getUTCDay();
    cells.push({ start: d, end: end > to ? to : end, label, weekend: zoom === 'day' && (dt === 0 || dt === 6) });
    d = addDays(end, 1);
  }
  return cells.map((c) => {
    const left = diffDays(from, c.start) * px; const w = (diffDays(c.start, c.end) + 1) * px;
    return `<div class="gcell${c.weekend ? ' we' : ''}" style="left:${left}px;width:${w}px">${esc(c.label)}</div>`;
  }).join('');
}

function lanes(items) {
  const ends = []; const out = [];
  for (const it of [...items].sort((a, b) => a.start.localeCompare(b.start))) {
    let i = ends.findIndex((e) => e < it.start);
    if (i < 0) { i = ends.length; ends.push(''); }
    ends[i] = it.end; out.push({ ...it, lane: i });
  }
  return { items: out, count: Math.max(1, ends.length) };
}

function pct(b) {
  if (b.cap <= 0) return b.booked > 0 ? { cls: 'u-over', txt: `${b.booked}h` } : { cls: 'u-zero', txt: '–' };
  const p = Math.round((b.booked / b.cap) * 100);
  return { cls: p > 100 ? 'u-over' : p >= 80 ? 'u-warn' : p === 0 ? 'u-zero' : 'u-ok', txt: p === 0 ? '' : `${p}%` };
}

/**
 * rows: [{ name, sub, nameHtml?, bars:[{start,end,label,title,href,cls}], unav:[{start,end,title}], caps:[{start,end,cap,booked}], due?:'YYYY-MM-DD' }]
 */
export function renderGantt({ from, to, zoom, rows, today }) {
  const px = PX[zoom]; const total = diffDays(from, to) + 1; const W = total * px;
  const clipL = (s) => Math.max(0, diffDays(from, s)) * px;
  const clipW = (s, e) => Math.max(px >= 12 ? 4 : 3, (diffDays(s < from ? from : s, e > to ? to : e) + 1) * px);
  const grid = zoom === 'month' ? '' : `background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px);background-size:${zoom === 'day' ? px : px * 7}px 100%;`;

  const body = rows.map((r) => {
    const L = lanes(r.bars || []);
    const barsH = L.count * 24 + 6; const capH = r.caps ? 20 : 0;
    const bars = L.items.map((b) => `<a class="gbar ${esc(b.cls || '')}" href="${esc(b.href || '#')}" style="left:${clipL(b.start)}px;width:${clipW(b.start, b.end)}px;top:${3 + b.lane * 24}px" title="${esc(b.title || b.label)}">${esc(b.label)}</a>`).join('');
    const un = (r.unav || []).map((u) => `<div class="gunav" style="left:${clipL(u.start)}px;width:${clipW(u.start, u.end)}px" title="${esc(u.title)}"></div>`).join('');
    const caps = (r.caps || []).map((b) => { const p = pct(b); return `<div class="gcap ${p.cls}" style="left:${clipL(b.start) + 1}px;width:${clipW(b.start, b.end) - 2}px" title="${esc(`${b.start}${b.end !== b.start ? ' → ' + b.end : ''}: ${b.booked}h booked / ${b.cap}h capacity`)}">${(diffDays(b.start, b.end) + 1) * px >= 26 ? p.txt : ''}</div>`; }).join('');
    const due = r.due && r.due >= from && r.due <= to ? `<div class="gdue" style="left:${clipL(r.due) + px / 2 - 6}px;top:${barsH / 2 - 6}px" title="Due ${esc(r.due)}"></div>` : '';
    return `<div class="grow"><div class="gname">${r.nameHtml || `<b>${esc(r.name)}</b>`}<small>${esc(r.sub || '')}</small></div>
      <div class="gtrack" style="width:${W}px;height:${barsH + capH}px;${grid}">${un}${bars}${due}${caps}</div></div>`;
  }).join('');

  const todayLine = today >= from && today <= to ? `<div class="gtoday" style="left:${230 + diffDays(from, today) * px + px / 2}px"></div>` : '';
  return `<div class="gwrap"><div class="ginner">
    <div class="grow ghead"><div class="gname">${rows.length} row(s)</div><div class="gtrack" style="width:${W}px;height:26px">${headerCells(from, to, zoom, px)}</div></div>
    ${body || '<div class="card muted">No data in this range.</div>'}${todayLine}</div></div>`;
}

export function shiftFrom(from, zoom, dir) {
  if (zoom === 'day') return addDays(from, dir * 14);
  if (zoom === 'week') return addDays(from, dir * 56);
  const [y, m] = from.split('-').map(Number);
  return fmtD(Date.UTC(y, m - 1 + dir * 6, 1));
}
export const startFor = (date, zoom) => (zoom === 'week' ? mondayOf(date) : zoom === 'month' ? date.slice(0, 7) + '-01' : date);
