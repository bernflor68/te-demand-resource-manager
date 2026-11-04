import { all } from './db.js';
import { days, workdays, isWeekend, parse, fmt, mondayOf, monthStart, monthEnd, addDays } from './dates.js';

// Capacity model (HOURS): daily capacity = weekly capacity / 5 on Mon-Fri, 0 on weekends and unavailable days.
// An assignment's planned hours are spread evenly across the working days of its date range.
const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);

export function dayLoad(resource, from, to, extra = [], excludeId = null) {
  const daily = resource.weekly_capacity_hours / 5;
  const map = new Map();
  for (const d of days(from, to)) map.set(d, { cap: isWeekend(parse(d)) ? 0 : daily, booked: 0, unavailable: false });
  for (const u of all('SELECT start_date, end_date FROM unavailability WHERE resource_id = ? AND end_date >= ? AND start_date <= ?',
    resource.id, from, to)) {
    for (const d of days(max(u.start_date, from), min(u.end_date, to))) { const c = map.get(d); c.cap = 0; c.unavailable = true; }
  }
  const asg = all(`SELECT id, start_date, end_date, planned_hours FROM assignments
                   WHERE resource_id = ? AND status <> 'Cancelled' AND end_date >= ? AND start_date <= ?`, resource.id, from, to);
  for (const a of [...asg, ...extra]) {
    if (excludeId && a.id === excludeId) continue;
    const wd = workdays(a.start_date, a.end_date);
    const span = days(a.start_date, a.end_date);
    const per = a.planned_hours / (wd || span.length);
    for (const d of days(max(a.start_date, from), min(a.end_date, to))) {
      if (wd && isWeekend(parse(d))) continue;
      map.get(d).booked += per;
    }
  }
  return map;
}

export function overloads(resource, start, end, hours, excludeId) {
  const map = dayLoad(resource, start, end, [{ start_date: start, end_date: end, planned_hours: hours }], excludeId);
  const bad = [];
  for (const [date, v] of map) if (v.booked > v.cap + 0.01) bad.push({ date, booked: +v.booked.toFixed(1), capacity: +v.cap.toFixed(1) });
  return bad;
}

export function unavailableOverlap(resourceId, start, end) {
  return all('SELECT start_date, end_date, reason FROM unavailability WHERE resource_id = ? AND end_date >= ? AND start_date <= ?',
    resourceId, start, end);
}

export function alignRange(from, to, zoom) {
  if (zoom === 'week') return { from: mondayOf(from), to: addDays(mondayOf(to), 6) };
  if (zoom === 'month') return { from: monthStart(from), to: monthEnd(to) };
  return { from, to };
}

export function buckets(map, zoom) {
  const key = (d) => (zoom === 'week' ? mondayOf(d) : zoom === 'month' ? monthStart(d) : d);
  const out = new Map();
  for (const [d, v] of map) {
    const k = key(d);
    const b = out.get(k) || { start: d, end: d, cap: 0, booked: 0 };
    b.end = d; b.cap += v.cap; b.booked += v.booked;
    out.set(k, b);
  }
  return [...out.values()].map((b) => ({ ...b, cap: +b.cap.toFixed(1), booked: +b.booked.toFixed(1) }));
}

export const dayCount = (from, to) => (parse(to) - parse(from)) / 864e5 + 1;
export { fmt };
