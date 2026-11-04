import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'te.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const get = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Lists of the SharePoint design map to tables:
// Requests -> requests | Resources -> resources | Assignments -> assignments |
// Unavailability -> unavailability | Reference lists -> sites, teams, categories |
// Audit log -> audit_log | Notifications -> notifications
db.exec(`
CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('requestor','technician','dispatch_manager','admin')),
  team_id INTEGER REFERENCES teams(id), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id), site_id INTEGER REFERENCES sites(id),
  weekly_capacity_hours REAL NOT NULL DEFAULT 40, skills TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id), equipment TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority TEXT NOT NULL CHECK (priority IN ('Low','Medium','High','Critical')),
  due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Submitted', prev_status TEXT,
  requestor_id INTEGER NOT NULL REFERENCES users(id), team_id INTEGER REFERENCES teams(id),
  safety_impact TEXT NOT NULL DEFAULT 'None' CHECK (safety_impact IN ('None','Low','High')),
  estimated_hours REAL, approver_id INTEGER REFERENCES users(id), decision_at TEXT, decision_comment TEXT,
  closed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  resource_id INTEGER NOT NULL REFERENCES resources(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, planned_hours REAL NOT NULL CHECK (planned_hours > 0),
  status TEXT NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned','Active','Done','Cancelled')),
  notes TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
);
CREATE TABLE IF NOT EXISTS unavailability (
  id INTEGER PRIMARY KEY, resource_id INTEGER NOT NULL REFERENCES resources(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT, CHECK (end_date >= start_date)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), filename TEXT NOT NULL,
  stored_name TEXT NOT NULL, size INTEGER NOT NULL, uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, request_id INTEGER, entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL,
  user_id INTEGER, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_id INTEGER,
  message TEXT NOT NULL, dedupe_key TEXT UNIQUE, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Indexes mirror the main filters and Gantt range queries
CREATE INDEX IF NOT EXISTS ix_req_status ON requests(status);
CREATE INDEX IF NOT EXISTS ix_req_site ON requests(site_id);
CREATE INDEX IF NOT EXISTS ix_req_team ON requests(team_id);
CREATE INDEX IF NOT EXISTS ix_req_cat ON requests(category_id);
CREATE INDEX IF NOT EXISTS ix_req_due ON requests(due_date);
CREATE INDEX IF NOT EXISTS ix_req_requestor ON requests(requestor_id);
CREATE INDEX IF NOT EXISTS ix_req_priority ON requests(priority);
CREATE INDEX IF NOT EXISTS ix_asg_res_dates ON assignments(resource_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS ix_asg_req ON assignments(request_id);
CREATE INDEX IF NOT EXISTS ix_unav_res_dates ON unavailability(resource_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS ix_audit_req ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS ix_res_team ON resources(team_id);
`);

export function audit(requestId, entity, entityId, action, userId, detail) {
  run('INSERT INTO audit_log (request_id, entity, entity_id, action, user_id, detail) VALUES (?,?,?,?,?,?)',
    requestId ?? null, entity, entityId ?? null, action, userId ?? null, detail ? JSON.stringify(detail) : null);
}
