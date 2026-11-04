import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, run, audit } from '../db.js';
import { HttpError, requireRole, issueToken, clearToken, loginThrottle } from '../auth.js';
import { STATUSES, PRIORITIES, SAFETY, ROLES, OPEN_STATUSES, isManager } from '../workflow.js';
import { today, mondayOf, addDays } from '../dates.js';
import { dayLoad } from '../capacity.js';
import { buildFilter, REQUEST_SELECT } from './requests.js';

export const publicRouter = Router();
export const router = Router();
const admin = requireRole('admin');

// ---------- Auth ----------
publicRouter.post('/auth/login', loginThrottle, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!u || !bcrypt.compareSync(String(req.body?.password || ''), u.password_hash)) {
    req.recordFailure?.();
    throw new HttpError(401, 'Invalid email or password');
  }
  issueToken(res, req, u);
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});
publicRouter.post('/auth/logout', (req, res) => { clearToken(res); res.json({ ok: true }); });
publicRouter.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const { id, name, email, role, team_id } = req.user;
  res.json({ id, name, email, role, team_id });
});
router.post('/auth/password', (req, res) => {
  const { current, next } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(next || '').length < 10) throw new HttpError(400, 'New password must be at least 10 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 10), u.id);
  audit(null, 'user', u.id, 'password_changed', u.id);
  res.json({ ok: true });
});

// ---------- Reference data for forms and filters ----------
router.get('/meta', (req, res) => {
  const out = {
    sites: all('SELECT * FROM sites ORDER BY name'), teams: all('SELECT * FROM teams ORDER BY name'),
    categories: all('SELECT * FROM categories ORDER BY name'),
    statuses: STATUSES, priorities: PRIORITIES, safety: SAFETY, roles: ROLES,
  };
  if (req.user.role !== 'requestor') out.resources = all('SELECT id, name, team_id, site_id, active FROM resources ORDER BY name');
  if (isManager(req.user)) out.users = all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name');
  res.json(out);
});

// ---------- Admin: users and reference lists ----------
router.get('/admin/users', admin, (_req, res) => res.json(all(`SELECT u.id, u.email, u.name, u.role, u.team_id, u.active, t.name AS team
  FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.name`)));
router.post('/admin/users', admin, (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Name is required');
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Invalid role');
  if (String(b.password || '').length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'A user with this email already exists');
  const id = run('INSERT INTO users (email, name, password_hash, role, team_id) VALUES (?,?,?,?,?)', email, String(b.name).trim(),
    bcrypt.hashSync(b.password, 10), b.role, b.team_id ? Number(b.team_id) : null).lastInsertRowid;
  audit(null, 'user', id, 'created', req.user.id, { email, role: b.role });
  res.status(201).json({ id });
});
router.patch('/admin/users/:id', admin, (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  if (id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'You cannot deactivate or demote yourself');
  const set = {};
  if (b.name !== undefined) set.name = String(b.name).trim();
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw new HttpError(400, 'Invalid role'); set.role = b.role; }
  if (b.team_id !== undefined) set.team_id = b.team_id ? Number(b.team_id) : null;
  if (b.active !== undefined) set.active = b.active ? 1 : 0;
  if (b.password) { if (String(b.password).length < 10) throw new HttpError(400, 'Password must be at least 10 characters'); set.password_hash = bcrypt.hashSync(b.password, 10); }
  const keys = Object.keys(set);
  if (keys.length) run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), id);
  audit(null, 'user', id, 'updated', req.user.id, { fields: keys.filter((k) => k !== 'password_hash') });
  res.json({ ok: true });
});
for (const table of ['sites', 'teams', 'categories']) {
  router.post(`/admin/${table}`, admin, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Name is required');
    if (get(`SELECT 1 FROM ${table} WHERE name = ?`, name)) throw new HttpError(409, 'Already exists');
    const id = run(`INSERT INTO ${table} (name) VALUES (?)`, name).lastInsertRowid;
    audit(null, table, id, 'created', req.user.id, { name });
    res.status(201).json({ id });
  });
  router.patch(`/admin/${table}/:id`, admin, (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    if (b.name !== undefined && String(b.name).trim()) run(`UPDATE ${table} SET name = ? WHERE id = ?`, String(b.name).trim().slice(0, 100), id);
    if (b.active !== undefined) run(`UPDATE ${table} SET active = ? WHERE id = ?`, b.active ? 1 : 0, id);
    audit(null, table, id, 'updated', req.user.id, b);
    res.json({ ok: true });
  });
}

// ---------- Notifications ----------
router.get('/notifications', (req, res) => {
  const rows = all('SELECT id, request_id, message, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  res.json({ rows, unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', req.user.id).n });
});
router.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
  if (ids?.length) run(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, req.user.id, ...ids);
  else run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

// ---------- Dashboard ----------
router.get('/dashboard', (req, res) => {
  const f = buildFilter(req.user, {});
  const by = (col, join = '') => all(`SELECT ${col} AS label, COUNT(*) AS n FROM requests r ${join} WHERE ${f.where} AND r.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) GROUP BY 1 ORDER BY n DESC`, ...f.params, ...OPEN_STATUSES);
  const count = (extra, ...p) => get(`SELECT COUNT(*) AS n FROM requests r WHERE ${f.where} AND ${extra}`, ...f.params, ...p).n;
  const t = today(); const ph = OPEN_STATUSES.map(() => '?').join(',');
  const out = {
    by_status: all(`SELECT r.status AS label, COUNT(*) AS n FROM requests r WHERE ${f.where} GROUP BY 1`, ...f.params),
    open: count(`r.status IN (${ph})`, ...OPEN_STATUSES),
    overdue: count(`r.due_date < ? AND r.status IN (${ph})`, t, ...OPEN_STATUSES),
    awaiting_approval: count("r.status = 'Pending Approval'"),
    to_triage: count("r.status IN ('Submitted','Triage')"),
    due_7d: count(`r.due_date BETWEEN ? AND ? AND r.status IN (${ph})`, t, addDays(t, 7), ...OPEN_STATUSES),
    by_team: by("COALESCE(t.name, 'Unassigned')", 'LEFT JOIN teams t ON t.id = r.team_id'),
    by_priority: by('r.priority'),
    by_site: by('s.name', 'JOIN sites s ON s.id = r.site_id'),
  };
  if (req.user.role !== 'requestor') {
    const from = mondayOf(t); const to = addDays(from, 27);
    out.utilization = all("SELECT r.*, t.name AS team FROM resources r JOIN teams t ON t.id = r.team_id WHERE r.active = 1 ORDER BY t.name, r.name").map((r) => {
      let cap = 0; let booked = 0;
      for (const v of dayLoad(r, from, to).values()) { cap += v.cap; booked += v.booked; }
      return { name: r.name, team: r.team, capacity: +cap.toFixed(1), booked: +booked.toFixed(1) };
    });
    out.utilization_range = { from, to };
  }
  res.json(out);
});

// ---------- CSV export (respects the caller's visibility) ----------
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};
router.get('/reports/requests.csv', (req, res) => {
  const f = buildFilter(req.user, req.query);
  const rows = all(`${REQUEST_SELECT} WHERE ${f.where} ORDER BY r.created_at DESC LIMIT 20000`, ...f.params);
  const cols = [['number', 'Number'], ['title', 'Title'], ['status', 'Status'], ['priority', 'Priority'], ['site', 'Site'], ['equipment', 'Equipment'],
    ['category', 'Category'], ['team', 'Team'], ['assignees', 'Assigned To'], ['requestor', 'Requestor'], ['due_date', 'Due date'],
    ['estimated_hours', 'Estimated hours'], ['safety_impact', 'Safety impact'], ['created_at', 'Created'], ['closed_at', 'Closed']];
  const csv = [cols.map((c) => csvCell(c[1])).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c[0]])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="te-requests.csv"');
  res.send('﻿' + csv);
});
