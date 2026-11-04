import { Router } from 'express';
import { all, get, run, audit } from '../db.js';
import { HttpError, requireRole } from '../auth.js';
import { validDate, diffDays, today, mondayOf, addDays } from '../dates.js';
import { dayLoad, buckets, alignRange } from '../capacity.js';
import { visibility } from './requests.js';

export const router = Router();
const mgr = requireRole('dispatch_manager', 'admin');
const notRequestor = (req, _res, next) => (req.user.role === 'requestor' ? next(new HttpError(403, 'Not available for requestors')) : next());

const RES_SELECT = `SELECT r.*, t.name AS team, s.name AS site, u.email AS user_email FROM resources r
  JOIN teams t ON t.id = r.team_id LEFT JOIN sites s ON s.id = r.site_id LEFT JOIN users u ON u.id = r.user_id`;

router.get('/resources', notRequestor, (_req, res) => res.json(all(`${RES_SELECT} ORDER BY r.name`)));

function resourceBody(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) { if (!String(b.name || '').trim()) throw new HttpError(400, 'Name is required'); out.name = String(b.name).trim().slice(0, 120); }
  if (!partial || b.team_id !== undefined) { if (!get('SELECT 1 FROM teams WHERE id = ?', Number(b.team_id))) throw new HttpError(400, 'Team is required'); out.team_id = Number(b.team_id); }
  if (b.site_id !== undefined) out.site_id = b.site_id ? Number(b.site_id) : null;
  if (b.user_id !== undefined) out.user_id = b.user_id ? Number(b.user_id) : null;
  if (b.skills !== undefined) out.skills = String(b.skills).slice(0, 300) || null;
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  if (!partial || b.weekly_capacity_hours !== undefined) {
    const h = Number(b.weekly_capacity_hours ?? 40);
    if (!(h >= 0 && h <= 80)) throw new HttpError(400, 'Weekly capacity must be between 0 and 80 hours');
    out.weekly_capacity_hours = h;
  }
  return out;
}

router.post('/resources', mgr, (req, res) => {
  const d = resourceBody(req.body || {}, false);
  const id = run('INSERT INTO resources (name, team_id, site_id, user_id, skills, weekly_capacity_hours) VALUES (?,?,?,?,?,?)',
    d.name, d.team_id, d.site_id ?? null, d.user_id ?? null, d.skills ?? null, d.weekly_capacity_hours).lastInsertRowid;
  audit(null, 'resource', id, 'created', req.user.id, d);
  res.status(201).json({ id });
});
router.patch('/resources/:id', mgr, (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 FROM resources WHERE id = ?', id)) throw new HttpError(404, 'Resource not found');
  const d = resourceBody(req.body || {}, true); const keys = Object.keys(d);
  if (keys.length) run(`UPDATE resources SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => d[k]), id);
  audit(null, 'resource', id, 'updated', req.user.id, d);
  res.json({ ok: true });
});

// ---------- Unavailability (all-day ranges) ----------
router.get('/unavailability', notRequestor, (req, res) => {
  const where = ['1=1']; const p = [];
  if (req.query.resource_id) { where.push('u.resource_id = ?'); p.push(Number(req.query.resource_id)); }
  if (req.query.from && validDate(req.query.from)) { where.push('u.end_date >= ?'); p.push(req.query.from); }
  if (req.query.to && validDate(req.query.to)) { where.push('u.start_date <= ?'); p.push(req.query.to); }
  res.json(all(`SELECT u.*, r.name AS resource FROM unavailability u JOIN resources r ON r.id = u.resource_id
    WHERE ${where.join(' AND ')} ORDER BY u.start_date LIMIT 500`, ...p));
});
router.post('/unavailability', mgr, (req, res) => {
  const b = req.body || {};
  if (!get('SELECT 1 FROM resources WHERE id = ?', Number(b.resource_id))) throw new HttpError(400, 'Resource is required');
  if (!validDate(b.start_date) || !validDate(b.end_date)) throw new HttpError(400, 'Start and end dates are required');
  if (b.end_date < b.start_date) throw new HttpError(400, 'End date must be on or after the start date');
  const id = run('INSERT INTO unavailability (resource_id, start_date, end_date, reason) VALUES (?,?,?,?)',
    Number(b.resource_id), b.start_date, b.end_date, String(b.reason || '').slice(0, 200) || null).lastInsertRowid;
  const clash = get(`SELECT COUNT(*) AS n FROM assignments WHERE resource_id = ? AND status <> 'Cancelled' AND end_date >= ? AND start_date <= ?`,
    Number(b.resource_id), b.start_date, b.end_date).n;
  audit(null, 'unavailability', id, 'created', req.user.id, b);
  res.status(201).json({ id, conflicting_assignments: clash });
});
router.delete('/unavailability/:id', mgr, (req, res) => {
  run('DELETE FROM unavailability WHERE id = ?', Number(req.params.id));
  audit(null, 'unavailability', Number(req.params.id), 'deleted', req.user.id);
  res.json({ ok: true });
});

// ---------- Gantt data (pre-aggregated server side: one call per view, no cross-list joins in the client) ----------
function range(q) {
  const zoom = ['day', 'week', 'month'].includes(q.zoom) ? q.zoom : 'week';
  const base = validDate(q.from) ? q.from : (zoom === 'month' ? today().slice(0, 7) + '-01' : mondayOf(today()));
  const span = { day: 28, week: 16 * 7, month: 365 }[zoom];
  const wantedTo = validDate(q.to) ? q.to : addDays(base, span - 1);
  const r = alignRange(base, wantedTo, zoom);
  if (diffDays(r.from, r.to) > 400) throw new HttpError(400, 'Date range too large (max ~13 months)');
  return { ...r, zoom };
}

router.get('/gantt/resources', notRequestor, (req, res) => {
  const { from, to, zoom } = range(req.query);
  const where = ['r.active = 1']; const p = [];
  if (req.query.team_id) { where.push('r.team_id = ?'); p.push(Number(req.query.team_id)); }
  if (req.query.site_id) { where.push('r.site_id = ?'); p.push(Number(req.query.site_id)); }
  if (req.user.role === 'technician' && req.query.scope === 'mine') { where.push('r.user_id = ?'); p.push(req.user.id); }
  const resources = all(`${RES_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.name, r.name`, ...p);
  const rows = resources.map((r) => {
    const assignments = all(`SELECT a.id, a.request_id, a.start_date, a.end_date, a.planned_hours, a.status, rq.number, rq.title, rq.priority, rq.status AS request_status
      FROM assignments a JOIN requests rq ON rq.id = a.request_id
      WHERE a.resource_id = ? AND a.status <> 'Cancelled' AND a.end_date >= ? AND a.start_date <= ? ORDER BY a.start_date`, r.id, from, to);
    const unavailability = all('SELECT id, start_date, end_date, reason FROM unavailability WHERE resource_id = ? AND end_date >= ? AND start_date <= ?', r.id, from, to);
    return { id: r.id, name: r.name, team: r.team, site: r.site, weekly_capacity_hours: r.weekly_capacity_hours,
      assignments, unavailability, buckets: buckets(dayLoad(r, from, to), zoom) };
  });
  res.json({ from, to, zoom, rows });
});

router.get('/gantt/requests', (req, res) => {
  const { from, to, zoom } = range(req.query);
  const v = visibility(req.user);
  const where = [v.sql, "r.status NOT IN ('Cancelled','Rejected')"]; const p = [...v.params];
  for (const [k, col] of [['site_id', 'r.site_id'], ['team_id', 'r.team_id'], ['category_id', 'r.category_id']])
    if (req.query[k]) { where.push(`${col} = ?`); p.push(Number(req.query[k])); }
  if (req.query.status) { const l = String(req.query.status).split(','); where.push(`r.status IN (${l.map(() => '?').join(',')})`); p.push(...l); }
  else where.push("r.status <> 'Closed'");
  where.push(`(r.due_date BETWEEN ? AND ? OR EXISTS (SELECT 1 FROM assignments ga WHERE ga.request_id = r.id AND ga.status <> 'Cancelled' AND ga.end_date >= ? AND ga.start_date <= ?))`);
  p.push(from, to, from, to);
  const requests = all(`SELECT r.id, r.number, r.title, r.priority, r.status, r.due_date, s.name AS site, t.name AS team
    FROM requests r JOIN sites s ON s.id = r.site_id LEFT JOIN teams t ON t.id = r.team_id
    WHERE ${where.join(' AND ')} ORDER BY r.due_date, r.id LIMIT 300`, ...p);
  const rows = requests.map((r) => ({ ...r, assignments: all(`SELECT a.id, a.start_date, a.end_date, a.planned_hours, a.status, res.name AS resource
    FROM assignments a JOIN resources res ON res.id = a.resource_id WHERE a.request_id = ? AND a.status <> 'Cancelled' ORDER BY a.start_date`, r.id) }));
  res.json({ from, to, zoom, rows, truncated: rows.length === 300 });
});
