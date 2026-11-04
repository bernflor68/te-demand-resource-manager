import { all, run } from './db.js';
import { addDays, today } from './dates.js';

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

export const managerIds = () =>
  all("SELECT id FROM users WHERE active = 1 AND role IN ('dispatch_manager','admin')").map((r) => r.id);

// In-app notification + optional webhook (Teams / Slack / n8n / Power Automate HTTP trigger).
export function notify(userIds, requestId, message, dedupePrefix) {
  for (const uid of new Set(userIds.filter(Boolean))) {
    const key = dedupePrefix ? `${dedupePrefix}:${uid}` : null;
    const r = run('INSERT OR IGNORE INTO notifications (user_id, request_id, message, dedupe_key) VALUES (?,?,?,?)',
      uid, requestId ?? null, message, key);
    if (r.changes > 0) sendWebhook(uid, requestId, message);
  }
}

function sendWebhook(userId, requestId, message) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: message, userId, requestId, link: requestId && APP_URL ? `${APP_URL}/#/requests/${requestId}` : null }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.warn('[notify] webhook failed:', e.message));
}

// Due date approaching (<= 3 days) and overdue reminders, once per day per user and request.
export function dueDateSweep() {
  const t = today();
  const rows = all(`SELECT id, number, title, due_date, requestor_id FROM requests
                    WHERE status IN ('Submitted','Triage','Pending Approval','Approved','Scheduled','In Progress','On Hold')
                    AND due_date <= ?`, addDays(t, 3));
  for (const r of rows) {
    const techs = all(`SELECT DISTINCT res.user_id AS id FROM assignments a JOIN resources res ON res.id = a.resource_id
                       WHERE a.request_id = ? AND a.status <> 'Cancelled' AND res.user_id IS NOT NULL`, r.id).map((x) => x.id);
    const overdue = r.due_date < t;
    const msg = overdue
      ? `${r.number} "${r.title}" is OVERDUE (due ${r.due_date})`
      : `${r.number} "${r.title}" is due on ${r.due_date}`;
    notify([r.requestor_id, ...managerIds(), ...techs], r.id, msg, `${overdue ? 'overdue' : 'due'}:${r.id}:${t}`);
  }
}

export function startScheduler() {
  const tick = () => { try { dueDateSweep(); } catch (e) { console.error('[scheduler]', e); } };
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 60e3).unref();
}
