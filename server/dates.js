// Date helpers. All business dates are ISO strings (YYYY-MM-DD) handled in UTC.
const DAY = 864e5;
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
export const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;
export const addDays = (s, n) => fmt(parse(s) + n * DAY);
export const today = () => fmt(Date.now());
export const isWeekend = (ms) => { const d = new Date(ms).getUTCDay(); return d === 0 || d === 6; };
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
export const mondayOf = (s) => { const d = new Date(parse(s)).getUTCDay(); return addDays(s, -((d + 6) % 7)); };
export const monthStart = (s) => s.slice(0, 7) + '-01';
export const monthEnd = (s) => { const [y, m] = s.split('-').map(Number); return fmt(Date.UTC(y, m, 0)); };
export function days(from, to) {
  const out = [];
  for (let t = parse(from); t <= parse(to); t += DAY) out.push(fmt(t));
  return out;
}
export function workdays(from, to) {
  let n = 0;
  for (let t = parse(from); t <= parse(to); t += DAY) if (!isWeekend(t)) n++;
  return n;
}
