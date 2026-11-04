import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { all, get, run, tx } from './db.js';
import { addDays, today, mondayOf } from './dates.js';

const hash = (pw) => bcrypt.hashSync(pw, 10);

export function seedIfEmpty() {
  tx(() => {
    if (!get('SELECT 1 FROM sites LIMIT 1')) {
      // ASSUMPTION: generic sample reference data; edit it from Admin > Reference data.
      for (const n of ['Site A', 'Site B', 'Site C']) run('INSERT INTO sites (name) VALUES (?)', n);
      for (const n of ['Mechanical', 'Electrical', 'Calibration']) run('INSERT INTO teams (name) VALUES (?)', n);
      for (const n of ['Repair', 'Preventive Maintenance', 'Installation', 'Calibration', 'Modification', 'Inspection'])
        run('INSERT INTO categories (name) VALUES (?)', n);
    }
    if (!get('SELECT 1 FROM users LIMIT 1')) {
      const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
      let pw = process.env.ADMIN_PASSWORD;
      if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); console.log(`\n[setup] Initial admin: ${email} / ${pw}  (change it after first login)\n`); }
      run("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')", email, 'Administrator', hash(pw));
    }
  });
  if (process.env.SEED_DEMO === 'true' && !get("SELECT 1 FROM users WHERE email = 'manager@example.com'")) seedDemo();
}

function seedDemo() {
  const pw = process.env.DEMO_PASSWORD || 'ChangeMe!2026';
  console.log(`[setup] Seeding demo data (demo users use password from DEMO_PASSWORD, default "${pw}")`);
  tx(() => {
    const team = (n) => get('SELECT id FROM teams WHERE name = ?', n).id;
    const site = (n) => get('SELECT id FROM sites WHERE name = ?', n).id;
    const cat = (n) => get('SELECT id FROM categories WHERE name = ?', n).id;
    const user = (email, name, role, teamId) =>
      run('INSERT INTO users (email, name, password_hash, role, team_id) VALUES (?,?,?,?,?)', email, name, hash(pw), role, teamId ?? null).lastInsertRowid;
    const mgr = user('manager@example.com', 'Dana Dispatch', 'dispatch_manager', null);
    const req1 = user('requestor@example.com', 'Rob Requestor', 'requestor', null);
    const req2 = user('requestor2@example.com', 'Rita Requestor', 'requestor', null);
    const staff = [['Tom Mechanic', 'Mechanical', 'Site A'], ['Mia Mechanic', 'Mechanical', 'Site B'], ['Eli Electric', 'Electrical', 'Site A'],
      ['Eva Electric', 'Electrical', 'Site C'], ['Cal Calibrator', 'Calibration', 'Site B']];
    const resIds = staff.map(([name, t, s], i) => {
      const uid = user(`tech${i + 1}@example.com`, name, 'technician', team(t));
      return run('INSERT INTO resources (name, user_id, team_id, site_id, weekly_capacity_hours, skills) VALUES (?,?,?,?,?,?)',
        name, uid, team(t), site(s), 40, t === 'Calibration' ? 'ISO 17025' : t).lastInsertRowid;
    });
    const mon = mondayOf(today());
    run('INSERT INTO unavailability (resource_id, start_date, end_date, reason) VALUES (?,?,?,?)', resIds[1], addDays(mon, 8), addDays(mon, 12), 'Annual leave');
    const mk = (n, title, s, eq, c, pr, due, status, t, hrs, rq) => {
      const id = run(`INSERT INTO requests (number, title, description, site_id, equipment, category_id, priority, due_date, status, requestor_id, team_id, estimated_hours)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, `TE-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`, title,
        `${title} - demo request.`, site(s), eq, cat(c), pr, due, status, rq, t ? team(t) : null, hrs).lastInsertRowid;
      run('INSERT INTO audit_log (request_id, entity, entity_id, action, user_id) VALUES (?,?,?,?,?)', id, 'request', id, 'created', rq);
      return id;
    };
    const asg = (r, res, s, e, h, st = 'Planned') =>
      run('INSERT INTO assignments (request_id, resource_id, start_date, end_date, planned_hours, status, created_by) VALUES (?,?,?,?,?,?,?)', r, res, s, e, h, st, mgr);
    const r1 = mk(1, 'Replace hydraulic press seal', 'Site A', 'PRESS-014', 'Repair', 'High', addDays(mon, 11), 'Scheduled', 'Mechanical', 24, req1);
    asg(r1, resIds[0], addDays(mon, 1), addDays(mon, 4), 24);
    const r2 = mk(2, 'Annual calibration of torque wrenches', 'Site B', 'TW-SET-02', 'Calibration', 'Medium', addDays(mon, 20), 'Scheduled', 'Calibration', 16, req2);
    asg(r2, resIds[4], addDays(mon, 7), addDays(mon, 9), 16);
    const r3 = mk(3, 'Install new conveyor sensor', 'Site C', 'CONV-007', 'Installation', 'Critical', addDays(mon, 6), 'In Progress', 'Electrical', 40, req1);
    asg(r3, resIds[3], addDays(mon, 0), addDays(mon, 4), 40, 'Active');
    mk(4, 'Inspect crane limit switches', 'Site A', 'CRANE-02', 'Inspection', 'High', addDays(mon, 14), 'Pending Approval', 'Electrical', 8, req2);
    mk(5, 'Modify fixture for new part', 'Site B', 'FIX-120', 'Modification', 'Low', addDays(mon, 30), 'Submitted', null, null, req1);
    mk(6, 'Preventive maintenance - compressor', 'Site A', 'COMP-01', 'Preventive Maintenance', 'Medium', addDays(mon, 3), 'Triage', 'Mechanical', 12, req2);
    const r7 = mk(7, 'Repair torque station arm', 'Site B', 'TS-33', 'Repair', 'High', addDays(mon, 16), 'Approved', 'Mechanical', 20, req1);
    run('UPDATE requests SET approver_id = ? WHERE id = ?', mgr, r7);
  });
  all('SELECT 1');
}
