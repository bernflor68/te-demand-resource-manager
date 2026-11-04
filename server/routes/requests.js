import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, audit, UPLOAD_DIR } from '../db.js';
import { HttpError, requireRole } from '../auth.js';
import { PRIORITIES, SAFETY, OPEN_STATUSES, STATUSES, TRANSITIONS, allowedTransitions, isManager } from '../workflow.js';
import { validDate, today } from '../dates.js';
import { overloads, unavailableOverlap } from '../capacity.js';
import { notify, managerIds } from '../notify.js';

export const router = Router();

export const REQUEST_SELECT = `SELECT r.*, s.name AS site, c.name AS category, t.name AS team, u.name AS requestor, ap.name AS approver,
  (SELECT group_concat(DISTINCT res.name) FROM assignments a JOIN resources res ON res.id = a.resource_id
    WHERE a.request_id = r.id AND a.status <> 'Cancelled') AS assignees
  FROM requests r JOIN sites s ON s.id = r.site_id JOIN categories c ON c.id = r.category_id
  LEFT JOIN teams t ON t.id = r.team_id JOIN users u ON u.id = r.requestor_id LEFT JOIN users ap ON ap.id = r.approver_id`;

// App-level access control (no SharePoint-style item permissions): visibility is enforced in every query.
export function visibility(user, alias = 'r') {
  if (isManager(user)) return { sql: '1=1', params: [] };
  if (user.role === 'technician') {
    return {
      sql: `(${alias}.requestor_id = ? OR ${alias}.team_id = ? OR EXISTS (SELECT 1 FROM assignments va JOIN resources vr ON vr.id = va.resource_id
             WHERE va.request_id = ${alias}.id AND vr.user_id = ?))`,
      params: [user.id, user.team_id ?? -1, user.id],
    };
  }
  return { sql: `${alias}.requestor_id = ?`, params: [user.id] };
}

export function buildFilter(user, q) {
  const v = visibility(user);
  const where = [v.sql]; const params = [...v.params];
  const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
  if (q.q) { where.push('(r.title LIKE ? OR r.description LIKE ? OR r.number LIKE ? OR r.equipment LIKE ?)'); const l = `%${q.q}%`; params.push(l, l, l, l); }
  for (const [key, col] of [['status', 'r.status'], ['priority', 'r.priority']]) {
    if (q[key]) { const l = list(q[key]); where.push(`${col} IN (${l.map(() => '?').join(',')})`); params.push(...l); }
  }
  for (const [key, col] of [['site_id', 'r.site_id'], ['category_id', 'r.category_id'], ['team_id', 'r.team_id'], ['requestor_id', 'r.requestor_id']]) {
    if (q[key]) { where.push(`${col} = ?`); params.push(Number(q[key])); }
  }
  if (q.assignee_id) {
    where.push("EXISTS (SELECT 1 FROM assignments fa WHERE fa.request_id = r.id AND fa.resource_id = ? AND fa.status <> 'Cancelled')");
    params.push(Number(q.assignee_id));
  }
  if (q.due_from && validDate(q.due_from)) { where.push('r.due_date >= ?'); params.push(q.due_from); }
  if (q.due_to && validDate(q.due_to)) { where.push('r.due_date <= ?'); params.push(q.due_to); }
  if (q.created_from && validDate(q.created_from)) { where.push('r.created_at >= ?'); params.push(q.created_from); }
  if (q.created_to && validDate(q.created_to)) { where.push('r.created_at < date(?, \'+1 day\')'); params.push(q.created_to); }
  if (q.overdue === '1') { where.push(`r.due_date < ? AND r.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(today(), ...OPEN_STATUSES); }
  if (q.open === '1') { where.push(`r.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
  return { where: where.join(' AND '), params };
}

const SORTS = { number: 'r.number', title: 'r.title', priority: "CASE r.priority WHEN 'Critical' THEN 4 WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 ELSE 1 END",
  status: 'r.status', due_date: 'r.due_date', created_at: 'r.created_at', site: 's.name', team: 't.name' };

router.get('/requests', (req, res) => {
  const f = buildFilter(req.user, req.query);
  const sort = SORTS[req.query.sort] || 'r.created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const total = get(`SELECT COUNT(*) AS n FROM requests r JOIN sites s ON s.id = r.site_id LEFT JOIN teams t ON t.id = r.team_id WHERE ${f.where}`, ...f.params).n;
  const rows = all(`${REQUEST_SELECT} WHERE ${f.where} ORDER BY ${sort} ${dir}, r.id DESC LIMIT ? OFFSET ?`, ...f.params, limit, offset);
  res.json({ rows, total, limit, offset });
});

function str(v, name, max, required = true) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  return s;
}
function refId(table, v, name) {
  const row = v ? get(`SELECT id FROM ${table} WHERE id = ? AND active = 1`, Number(v)) : null;
  if (!row) throw new HttpError(400, `${name} is required`);
  return row.id;
}
function oneOf(v, list, name) {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}

router.post('/requests', (req, res) => {
  const b = req.body || {};
  const data = {
    title: str(b.title, 'Title', 200), description: str(b.description, 'Description', 5000),
    site_id: refId('sites', b.site_id, 'Site/Location'), equipment: str(b.equipment, 'Equipment/Asset ID', 200),
    category_id: refId('categories', b.category_id, 'Category'), priority: oneOf(b.priority, PRIORITIES, 'Priority'),
    due_date: b.due_date,
    safety_impact: b.safety_impact ? oneOf(b.safety_impact, SAFETY, 'Safety impact') : 'None',
  };
  if (!validDate(data.due_date)) throw new HttpError(400, 'Requested due date is required (YYYY-MM-DD)');
  if (data.due_date < today()) throw new HttpError(400, 'Requested due date cannot be in the past');
  const created = tx(() => {
    const year = new Date().getUTCFullYear();
    const last = get('SELECT number FROM requests WHERE number LIKE ? ORDER BY number DESC LIMIT 1', `TE-${year}-%`);
    const seq = last ? Number(last.number.split('-')[2]) + 1 : 1;
    const number = `TE-${year}-${String(seq).padStart(4, '0')}`;
    const id = run(`INSERT INTO requests (number, title, description, site_id, equipment, category_id, priority, due_date, safety_impact, requestor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, number, data.title, data.description, data.site_id, data.equipment, data.category_id,
      data.priority, data.due_date, data.safety_impact, req.user.id).lastInsertRowid;
    audit(id, 'request', id, 'created', req.user.id, { number });
    return { id, number };
  });
  notify(managerIds(), created.id, `New request ${created.number} "${data.title}" submitted by ${req.user.name}`);
  res.status(201).json(created);
});

function loadRequest(req, id, { forWrite = false } = {}) {
  const v = visibility(req.user);
  const r = get(`${REQUEST_SELECT} WHERE r.id = ? AND ${v.sql}`, Number(id), ...v.params);
  if (!r) throw new HttpError(404, 'Request not found');
  return r;
}
const isAssignee = (user, requestId) => !!get(`SELECT 1 FROM assignments a JOIN resources res ON res.id = a.resource_id
  WHERE a.request_id = ? AND res.user_id = ? AND a.status <> 'Cancelled'`, requestId, user.id);

router.get('/requests/:id', (req, res) => {
  const r = loadRequest(req, req.params.id);
  const assignments = all(`SELECT a.*, res.name AS resource, res.team_id AS resource_team_id FROM assignments a
    JOIN resources res ON res.id = a.resource_id WHERE a.request_id = ? ORDER BY a.start_date, a.id`, r.id);
  const comments = all('SELECT c.*, u.name AS user FROM comments c JOIN users u ON u.id = c.user_id WHERE c.request_id = ? ORDER BY c.id', r.id);
  const attachments = all(`SELECT a.id, a.filename, a.size, a.created_at, u.name AS uploaded_by FROM attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.request_id = ? ORDER BY a.id`, r.id);
  const history = all(`SELECT l.id, l.action, l.entity, l.detail, l.created_at, u.name AS user FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id WHERE l.request_id = ? ORDER BY l.id DESC LIMIT 200`, r.id);
  const transitions = allowedTransitions(req.user, r, isAssignee(req.user, r.id))
    .map(({ to, label, comment }) => ({ to, label, comment: !!comment }));
  const editable = isManager(req.user) ? OPEN_STATUSES.includes(r.status) || r.status === 'Rejected'
    : r.requestor_id === req.user.id && ['Submitted', 'Triage'].includes(r.status);
  res.json({ ...r, assignments, comments, attachments, history, transitions, editable, can_assign: isManager(req.user) });
});

router.patch('/requests/:id', (req, res) => {
  const r = loadRequest(req, req.params.id);
  const mgr = isManager(req.user);
  const owner = r.requestor_id === req.user.id && ['Submitted', 'Triage'].includes(r.status);
  if (!(mgr && (OPEN_STATUSES.includes(r.status) || r.status === 'Rejected')) && !owner) throw new HttpError(403, 'This request cannot be edited');
  const b = req.body || {}; const set = {};
  if (b.title !== undefined) set.title = str(b.title, 'Title', 200);
  if (b.description !== undefined) set.description = str(b.description, 'Description', 5000);
  if (b.equipment !== undefined) set.equipment = str(b.equipment, 'Equipment/Asset ID', 200);
  if (b.site_id !== undefined) set.site_id = refId('sites', b.site_id, 'Site/Location');
  if (b.category_id !== undefined) set.category_id = refId('categories', b.category_id, 'Category');
  if (b.priority !== undefined) set.priority = oneOf(b.priority, PRIORITIES, 'Priority');
  if (b.due_date !== undefined) { if (!validDate(b.due_date)) throw new HttpError(400, 'Invalid due date'); set.due_date = b.due_date; }
  if (mgr) {
    if (b.team_id !== undefined) set.team_id = b.team_id ? refId('teams', b.team_id, 'Team') : null;
    if (b.safety_impact !== undefined) set.safety_impact = oneOf(b.safety_impact, SAFETY, 'Safety impact');
    if (b.estimated_hours !== undefined) {
      const h = b.estimated_hours === '' || b.estimated_hours === null ? null : Number(b.estimated_hours);
      if (h !== null && (!(h >= 0) || h > 10000)) throw new HttpError(400, 'Estimated hours must be a positive number');
      set.estimated_hours = h;
    }
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.json({ ok: true });
  const diff = {};
  for (const k of keys) if (String(r[k] ?? '') !== String(set[k] ?? '')) diff[k] = { from: r[k], to: set[k] };
  if (!Object.keys(diff).length) return res.json({ ok: true });
  run(`UPDATE requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => set[k]), r.id);
  audit(r.id, 'request', r.id, 'updated', req.user.id, diff);
  res.json({ ok: true });
});

router.post('/requests/:id/transition', (req, res) => {
  const r = loadRequest(req, req.params.id);
  const { to, comment } = req.body || {};
  const rule = allowedTransitions(req.user, r, isAssignee(req.user, r.id)).find((t) => t.to === to);
  if (!rule) throw new HttpError(403, `Transition "${r.status}" -> "${to}" is not allowed for you`);
  const note = typeof comment === 'string' ? comment.trim().slice(0, 2000) : '';
  if (rule.comment && !note) throw new HttpError(400, 'A comment is required for this action');
  if (rule.needsTeam && !r.team_id) throw new HttpError(400, 'Assign a team before submitting for approval');
  const target = to === '@resume' ? (r.prev_status || 'Triage') : to;
  tx(() => {
    const sets = ['status = ?', "updated_at = datetime('now')"]; const params = [target];
    if (target === 'On Hold') { sets.push('prev_status = ?'); params.push(r.status); } else sets.push('prev_status = NULL');
    if (r.status === 'Pending Approval' && (target === 'Approved' || target === 'Rejected')) {
      sets.push("approver_id = ?", "decision_at = datetime('now')", 'decision_comment = ?'); params.push(req.user.id, note || null);
    }
    if (target === 'Closed') sets.push("closed_at = datetime('now')");
    run(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`, ...params, r.id);
    if (target === 'In Progress') run("UPDATE assignments SET status = 'Active' WHERE request_id = ? AND status IN ('Planned','Done')", r.id);
    if (target === 'Completed') run("UPDATE assignments SET status = 'Done' WHERE request_id = ? AND status IN ('Planned','Active')", r.id);
    if (target === 'Cancelled') run("UPDATE assignments SET status = 'Cancelled' WHERE request_id = ? AND status <> 'Done'", r.id);
    if (note) run('INSERT INTO comments (request_id, user_id, body) VALUES (?,?,?)', r.id, req.user.id, `[${rule.label}] ${note}`);
    audit(r.id, 'request', r.id, 'status_changed', req.user.id, { from: r.status, to: target, comment: note || undefined });
  });
  const techs = all(`SELECT DISTINCT res.user_id AS id FROM assignments a JOIN resources res ON res.id = a.resource_id
    WHERE a.request_id = ? AND res.user_id IS NOT NULL`, r.id).map((x) => x.id);
  const audience = [r.requestor_id, ...techs, ...(target === 'Pending Approval' ? managerIds() : [])].filter((id) => id !== req.user.id);
  notify(audience, r.id, target === 'Pending Approval'
    ? `${r.number} "${r.title}" is awaiting approval`
    : `${r.number} "${r.title}" moved to ${target} by ${req.user.name}`);
  res.json({ ok: true, status: target });
});

router.post('/requests/:id/comments', (req, res) => {
  const r = loadRequest(req, req.params.id);
  const body = str(req.body?.body, 'Comment', 2000);
  const id = run('INSERT INTO comments (request_id, user_id, body) VALUES (?,?,?)', r.id, req.user.id, body).lastInsertRowid;
  audit(r.id, 'comment', id, 'commented', req.user.id);
  notify([r.requestor_id, ...(isManager(req.user) ? [] : managerIds())].filter((u) => u !== req.user.id), r.id, `New comment on ${r.number} from ${req.user.name}`);
  res.status(201).json({ id });
});

// ---------- Attachments (stored on disk, metadata in DB) ----------
const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.msg', '.eml']);
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_q, _f, cb) => cb(null, crypto.randomUUID()) }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 5 },
  fileFilter: (_q, file, cb) => (ALLOWED.has(path.extname(file.originalname).toLowerCase()) ? cb(null, true)
    : cb(new HttpError(400, `File type not allowed: ${path.extname(file.originalname) || file.originalname}`))),
});

router.post('/requests/:id/attachments', (req, res, next) => {
  try { loadRequest(req, req.params.id); } catch (e) { return next(e); }
  upload.array('files', 5)(req, res, (err) => {
    if (err) return next(err.code === 'LIMIT_FILE_SIZE' ? new HttpError(400, `File too large (max ${MAX_MB} MB)`) : err);
    const r = loadRequest(req, req.params.id);
    if (get('SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?', r.id).n + req.files.length > 20) {
      req.files.forEach((f) => fs.rmSync(f.path, { force: true }));
      return next(new HttpError(400, 'Maximum 20 attachments per request'));
    }
    for (const f of req.files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200);
      const id = run('INSERT INTO attachments (request_id, filename, stored_name, size, uploaded_by) VALUES (?,?,?,?,?)', r.id, name, f.filename, f.size, req.user.id).lastInsertRowid;
      audit(r.id, 'attachment', id, 'attachment_added', req.user.id, { filename: name });
    }
    res.status(201).json({ ok: true, count: req.files.length });
  });
});

router.get('/attachments/:id', (req, res) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Attachment not found');
  loadRequest(req, a.request_id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(path.join(UPLOAD_DIR, a.stored_name), a.filename);
});

router.delete('/attachments/:id', (req, res) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Attachment not found');
  loadRequest(req, a.request_id);
  if (!isManager(req.user) && a.uploaded_by !== req.user.id) throw new HttpError(403, 'Not allowed');
  run('DELETE FROM attachments WHERE id = ?', a.id);
  fs.rmSync(path.join(UPLOAD_DIR, a.stored_name), { force: true });
  audit(a.request_id, 'attachment', a.id, 'attachment_removed', req.user.id, { filename: a.filename });
  res.json({ ok: true });
});

// ---------- Assignments ----------
function validateAssignment(b, existing) {
  const resource = get('SELECT * FROM resources WHERE id = ? AND active = 1', Number(b.resource_id ?? existing?.resource_id));
  if (!resource) throw new HttpError(400, 'Resource is required and must be active');
  const start = b.start_date ?? existing?.start_date; const end = b.end_date ?? existing?.end_date;
  if (!validDate(start) || !validDate(end)) throw new HttpError(400, 'Start and end dates are required (YYYY-MM-DD)');
  if (end < start) throw new HttpError(400, 'End date must be on or after the start date');
  if (parseDays(start, end) > 366) throw new HttpError(400, 'An assignment cannot exceed 366 days');
  const hours = Number(b.planned_hours ?? existing?.planned_hours);
  if (!(hours > 0) || hours > 5000) throw new HttpError(400, 'Planned hours must be greater than 0');
  return { resource, start, end, hours };
}
const parseDays = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5 + 1;

function checkConflicts(v, force, user, excludeId) {
  const un = unavailableOverlap(v.resource.id, v.start, v.end);
  if (un.length) throw new HttpError(409, `${v.resource.name} is unavailable ${un[0].start_date} to ${un[0].end_date}${un[0].reason ? ` (${un[0].reason})` : ''}`, { code: 'UNAVAILABLE' });
  const over = overloads(v.resource, v.start, v.end, v.hours, excludeId);
  if (over.length && !force) {
    throw new HttpError(409, `Over capacity on ${over.length} day(s), e.g. ${over[0].date}: ${over[0].booked}h booked vs ${over[0].capacity}h capacity. Confirm to override.`, { code: 'OVERBOOKED', days: over.slice(0, 10) });
  }
  return over.length > 0;
}

router.post('/requests/:id/assignments', requireRole('dispatch_manager', 'admin'), (req, res) => {
  const r = loadRequest(req, req.params.id);
  if (!['Approved', 'Scheduled', 'In Progress'].includes(r.status)) throw new HttpError(409, 'Assignments require an approved request (Approved, Scheduled or In Progress)');
  const v = validateAssignment(req.body || {});
  const over = checkConflicts(v, req.body?.force === true, req.user);
  const id = tx(() => {
    const aid = run(`INSERT INTO assignments (request_id, resource_id, start_date, end_date, planned_hours, status, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)`, r.id, v.resource.id, v.start, v.end, v.hours, r.status === 'In Progress' ? 'Active' : 'Planned',
      (req.body?.notes || '').toString().slice(0, 1000) || null, req.user.id).lastInsertRowid;
    audit(r.id, 'assignment', aid, 'assigned', req.user.id, { resource: v.resource.name, start: v.start, end: v.end, hours: v.hours, overbooked: over || undefined });
    if (r.status === 'Approved') {
      run("UPDATE requests SET status = 'Scheduled', updated_at = datetime('now') WHERE id = ?", r.id);
      audit(r.id, 'request', r.id, 'status_changed', req.user.id, { from: 'Approved', to: 'Scheduled', auto: true });
    }
    return aid;
  });
  notify([v.resource.user_id], r.id, `You were assigned to ${r.number} "${r.title}" (${v.start} to ${v.end}, ${v.hours}h)`);
  notify([r.requestor_id], r.id, `${r.number} "${r.title}" has been scheduled (${v.start} to ${v.end})`);
  res.status(201).json({ id, overbooked: over });
});

router.patch('/assignments/:id', requireRole('dispatch_manager', 'admin'), (req, res) => {
  const a = get('SELECT * FROM assignments WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Assignment not found');
  const r = loadRequest(req, a.request_id);
  if (a.status === 'Cancelled') throw new HttpError(409, 'A cancelled assignment cannot be changed');
  const b = req.body || {};
  const v = validateAssignment(b, a);
  const over = checkConflicts(v, b.force === true, req.user, a.id);
  run('UPDATE assignments SET resource_id = ?, start_date = ?, end_date = ?, planned_hours = ?, notes = ? WHERE id = ?',
    v.resource.id, v.start, v.end, v.hours, b.notes !== undefined ? String(b.notes).slice(0, 1000) : a.notes, a.id);
  audit(r.id, 'assignment', a.id, 'assignment_updated', req.user.id, { resource: v.resource.name, start: v.start, end: v.end, hours: v.hours, overbooked: over || undefined });
  notify([v.resource.user_id], r.id, `Your assignment on ${r.number} changed (${v.start} to ${v.end}, ${v.hours}h)`);
  res.json({ ok: true, overbooked: over });
});

router.delete('/assignments/:id', requireRole('dispatch_manager', 'admin'), (req, res) => {
  const a = get('SELECT * FROM assignments WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Assignment not found');
  const r = loadRequest(req, a.request_id);
  tx(() => {
    run("UPDATE assignments SET status = 'Cancelled' WHERE id = ?", a.id);
    audit(r.id, 'assignment', a.id, 'assignment_cancelled', req.user.id);
    const left = get("SELECT COUNT(*) AS n FROM assignments WHERE request_id = ? AND status <> 'Cancelled'", r.id).n;
    if (!left && r.status === 'Scheduled') {
      run("UPDATE requests SET status = 'Approved', updated_at = datetime('now') WHERE id = ?", r.id);
      audit(r.id, 'request', r.id, 'status_changed', req.user.id, { from: 'Scheduled', to: 'Approved', auto: true });
    }
  });
  const res_ = get('SELECT user_id FROM resources WHERE id = ?', a.resource_id);
  notify([res_?.user_id], r.id, `Your assignment on ${r.number} was cancelled`);
  res.json({ ok: true });
});

export { STATUSES, TRANSITIONS };
