import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-test-'));
let proc;
const jars = {};

async function call(who, method, url, body) {
  const res = await fetch(BASE + '/api' + url, { method, headers: { 'content-type': 'application/json', cookie: jars[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tomorrow = () => new Date(Date.now() + 864e5 * 20).toISOString().slice(0, 10);

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dir, SEED_DEMO: 'true', ADMIN_PASSWORD: 'Admin!Passw0rd', DEMO_PASSWORD: 'Demo!Passw0rd1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  for (const [who, email] of [['mgr', 'manager@example.com'], ['req', 'requestor@example.com'], ['req2', 'requestor2@example.com'], ['tech', 'tech1@example.com']]) {
    assert.equal((await call(who, 'POST', '/auth/login', { email, password: 'Demo!Passw0rd1' })).status, 200);
  }
});
after(async () => {
  if (proc) { const done = new Promise((r) => proc.once('exit', r)); proc.kill(); await done; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may keep a lock briefly; temp dir is disposable */ }
});

test('anonymous access is rejected; bad login fails', async () => {
  assert.equal((await call('anon', 'GET', '/requests')).status, 401);
  assert.equal((await call('anon', 'POST', '/auth/login', { email: 'manager@example.com', password: 'nope' })).status, 401);
});

test('mandatory fields are validated at creation', async () => {
  const r = await call('req', 'POST', '/requests', { title: 'x' });
  assert.equal(r.status, 400);
  const past = await call('req', 'POST', '/requests', { title: 'x', description: 'd', site_id: 1, equipment: 'E', category_id: 1, priority: 'High', due_date: '2020-01-01' });
  assert.equal(past.status, 400);
});

test('full lifecycle: create > triage > approve > assign > complete > close', async () => {
  const c = await call('req', 'POST', '/requests', { title: 'Lifecycle', description: 'd', site_id: 1, equipment: 'E-1', category_id: 1, priority: 'High', due_date: tomorrow() });
  assert.equal(c.status, 201); const id = c.data.id;
  assert.equal((await call('req', 'POST', `/requests/${id}/transition`, { to: 'Approved' })).status, 403, 'requestor cannot approve');
  assert.equal((await call('mgr', 'POST', `/requests/${id}/transition`, { to: 'Triage' })).status, 200);
  assert.equal((await call('mgr', 'POST', `/requests/${id}/transition`, { to: 'Pending Approval' })).status, 400, 'team required');
  await call('mgr', 'PATCH', `/requests/${id}`, { team_id: 1, estimated_hours: 16 });
  assert.equal((await call('mgr', 'POST', `/requests/${id}/transition`, { to: 'Pending Approval' })).status, 200);
  assert.equal((await call('mgr', 'POST', `/requests/${id}/assignments`, { resource_id: 1, start_date: tomorrow(), end_date: tomorrow(), planned_hours: 4 })).status, 409, 'no assignment before approval');
  assert.equal((await call('mgr', 'POST', `/requests/${id}/transition`, { to: 'Approved' })).status, 200);
  const a = await call('mgr', 'POST', `/requests/${id}/assignments`, { resource_id: 1, start_date: '2030-03-04', end_date: '2030-03-08', planned_hours: 20 });
  assert.equal(a.status, 201);
  assert.equal((await call('mgr', 'GET', `/requests/${id}`)).data.status, 'Scheduled', 'auto-scheduled on first assignment');
  assert.equal((await call('tech', 'POST', `/requests/${id}/transition`, { to: 'In Progress' })).status, 200, 'assigned technician starts work');
  assert.equal((await call('tech', 'POST', `/requests/${id}/transition`, { to: 'Completed' })).status, 200);
  assert.equal((await call('req', 'POST', `/requests/${id}/transition`, { to: 'Closed' })).status, 200, 'owner closes');
  const d = await call('mgr', 'GET', `/requests/${id}`);
  assert.ok(d.data.history.length >= 6, 'audit trail recorded');
});

test('capacity: overbooking needs confirmation; unavailability blocks', async () => {
  const mk = async () => { const c = await call('req', 'POST', '/requests', { title: 'Cap', description: 'd', site_id: 1, equipment: 'E', category_id: 1, priority: 'Low', due_date: tomorrow() });
    await call('mgr', 'POST', `/requests/${c.data.id}/transition`, { to: 'Triage' }); await call('mgr', 'PATCH', `/requests/${c.data.id}`, { team_id: 1 });
    await call('mgr', 'POST', `/requests/${c.data.id}/transition`, { to: 'Pending Approval' }); await call('mgr', 'POST', `/requests/${c.data.id}/transition`, { to: 'Approved' }); return c.data.id; };
  const [r1, r2] = [await mk(), await mk()];
  const week = { start_date: '2031-03-03', end_date: '2031-03-07' };
  assert.equal((await call('mgr', 'POST', `/requests/${r1}/assignments`, { resource_id: 2, ...week, planned_hours: 40 })).status, 201);
  const over = await call('mgr', 'POST', `/requests/${r2}/assignments`, { resource_id: 2, ...week, planned_hours: 10 });
  assert.equal(over.status, 409); assert.equal(over.data.code, 'OVERBOOKED');
  assert.equal((await call('mgr', 'POST', `/requests/${r2}/assignments`, { resource_id: 2, ...week, planned_hours: 10, force: true })).status, 201);
  await call('mgr', 'POST', '/unavailability', { resource_id: 3, start_date: '2031-04-01', end_date: '2031-04-04', reason: 'Leave' });
  const un = await call('mgr', 'POST', `/requests/${r2}/assignments`, { resource_id: 3, start_date: '2031-04-02', end_date: '2031-04-03', planned_hours: 4 });
  assert.equal(un.status, 409); assert.equal(un.data.code, 'UNAVAILABLE');
});

test('gantt by resource exposes bars, unavailability overlay and capacity buckets', async () => {
  const g = await call('mgr', 'GET', '/gantt/resources?zoom=week&from=2031-03-03&to=2031-04-06');
  assert.equal(g.status, 200);
  const row = g.data.rows.find((r) => r.id === 2);
  assert.ok(row.assignments.length >= 2);
  const wk = row.buckets.find((b) => b.start === '2031-03-03');
  assert.equal(wk.cap, 40); assert.equal(wk.booked, 50);
  assert.ok(g.data.rows.find((r) => r.id === 3).unavailability.length >= 1);
  assert.equal((await call('req', 'GET', '/gantt/resources')).status, 403, 'requestors have no resource view');
});

test('requestors only see their own requests', async () => {
  const mine = await call('req2', 'GET', '/requests?limit=200');
  assert.ok(mine.data.rows.every((r) => r.requestor === 'Rita Requestor'));
  const other = await call('req', 'GET', '/requests?limit=200');
  const foreign = mine.data.rows[0];
  assert.equal((await call('req', 'GET', `/requests/${foreign.id}`)).status, 404);
  assert.ok(other.data.total > 0);
});
