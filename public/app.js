import { $, $$, esc, api, toast, opts, chip, prio, fmtTs, modal, todayStr, addDays, mondayOf, ApiError } from './util.js';
import { renderGantt, shiftFrom, startFor } from './gantt.js';

const S = { me: null, meta: null, unread: 0, filters: {}, page: 0, sort: 'created_at', dir: 'desc', gantt: { zoom: 'week', from: null, team_id: '', site_id: '', scope: '' } };
const isMgr = () => ['dispatch_manager', 'admin'].includes(S.me.role);
const ROLE_LABEL = { requestor: 'Requestor', technician: 'Technician', dispatch_manager: 'Dispatch Manager', admin: 'Administrator' };
const active = (list) => list.filter((x) => x.active);

// ---------------------------------------------------------------- bootstrap
async function boot() {
  try { S.me = await api('/auth/me'); } catch { return loginView(); }
  S.meta = await api('/meta');
  shell(); refreshNotif(); setInterval(refreshNotif, 60000);
  window.addEventListener('hashchange', route); route();
}

function loginView() {
  $('#app').innerHTML = `<form class="card login" id="lf"><h1>T&amp;E Demand &amp; Resource Manager</h1>
    <p class="muted">Sign in to submit, dispatch and plan work requests.</p>
    <label>Email</label><input name="email" type="email" autocomplete="username" required autofocus>
    <label style="margin-top:10px">Password</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="le" hidden></div><p><button class="primary" style="width:100%">Sign in</button></p></form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } }); location.hash = '#/dashboard'; boot(); }
    catch (ex) { const el = $('#le'); el.textContent = ex.message; el.hidden = false; }
  };
}

function shell() {
  const m = isMgr(); const nav = [['/dashboard', 'Dashboard'], ['/requests', 'Requests'], ['/requests/new', '+ New request']];
  const plan = [];
  if (m) plan.push(['/requests?status=Pending Approval', 'Approvals']);
  if (S.me.role !== 'requestor') plan.push(['/gantt/resources', 'Gantt by Resource']);
  plan.push(['/gantt/requests', 'Gantt by Request']);
  if (S.me.role !== 'requestor') plan.push(['/resources', 'Resources']);
  const link = ([h, t]) => `<a href="#${h}" data-h="${esc(h)}">${esc(t)}</a>`;
  $('#app').innerHTML = `<div class="shell"><aside class="side"><div class="brand"><i></i>T&amp;E Manager</div><nav>
    ${nav.map(link).join('')}<div class="sec">Planning</div>${plan.map(link).join('')}
    ${S.me.role === 'admin' ? `<div class="sec">Administration</div>${link(['/admin', 'Admin'])}` : ''}</nav></aside>
    <div class="main"><div class="top"><button class="bell" id="bell" title="Notifications">🔔<b id="nb" hidden>0</b></button>
      <span><b>${esc(S.me.name)}</b> <span class="muted">· ${ROLE_LABEL[S.me.role]}</span></span>
      <button class="sm" id="pw">Password</button><button class="sm" id="out">Sign out</button></div><div class="content" id="view"></div></div></div>`;
  $('#out').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.hash = ''; location.reload(); };
  $('#pw').onclick = () => modal('Change password', `<label class="req">Current password</label><input type="password" name="current" autocomplete="current-password">
    <label class="req" style="margin-top:10px">New password (min. 10 characters)</label><input type="password" name="next" autocomplete="new-password">`,
  { onSubmit: async (v) => { await api('/auth/password', { method: 'POST', body: v }); toast('Password updated'); } });
  $('#bell').onclick = toggleNotif;
}

// ---------------------------------------------------------------- notifications
async function refreshNotif() {
  try { const n = await api('/notifications'); S.unread = n.unread; const b = $('#nb'); if (b) { b.textContent = n.unread; b.hidden = !n.unread; } S.notifs = n.rows; } catch { /* ignore */ }
}
function toggleNotif() {
  const ex = $('.notif'); if (ex) return ex.remove();
  const el = document.createElement('div'); el.className = 'notif';
  el.innerHTML = (S.notifs?.length ? `<div style="text-align:right"><button class="sm" id="mr">Mark all read</button></div>` : '') +
    (S.notifs || []).map((n) => `<div class="${n.read ? '' : 'unread'}" data-id="${n.id}" data-r="${n.request_id || ''}">${esc(n.message)}<small>${fmtTs(n.created_at)}</small></div>`).join('') || '<div class="muted">No notifications</div>';
  $('.top').append(el);
  el.onclick = async (e) => {
    if (e.target.id === 'mr') { await api('/notifications/read', { method: 'POST', body: {} }); await refreshNotif(); return el.remove(); }
    const row = e.target.closest('[data-id]'); if (!row) return;
    await api('/notifications/read', { method: 'POST', body: { ids: [+row.dataset.id] } }); refreshNotif(); el.remove();
    if (row.dataset.r) location.hash = `#/requests/${row.dataset.r}`;
  };
}

// ---------------------------------------------------------------- router
const routes = [
  [/^\/dashboard$/, dashboard], [/^\/requests$/, requestList], [/^\/requests\/new$/, requestForm], [/^\/requests\/(\d+)$/, requestDetail],
  [/^\/gantt\/resources$/, ganttResources], [/^\/gantt\/requests$/, ganttRequests], [/^\/resources$/, resourcesPage], [/^\/admin$/, adminPage],
];
async function route() {
  $('.notif')?.remove();
  const [path, qs] = (location.hash.slice(1) || '/dashboard').split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const a of $$('.side nav a')) a.classList.toggle('active', a.dataset.h === (path + (qs ? '?' + decodeURIComponent(qs) : '')) || (!qs && a.dataset.h === path));
  const view = $('#view');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { view.innerHTML = '<p class="muted">Loading…</p>'; await fn(view, q, m[1]); }
      catch (e) { if (e.status === 401) return location.reload(); view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="err">${esc(e.message)}</p></div>`; }
      return;
    }
  }
  view.innerHTML = '<div class="card">Page not found.</div>';
}
const go = (h) => { if (location.hash === '#' + h) route(); else location.hash = h; };

// ---------------------------------------------------------------- dashboard
const bars = (rows, total) => rows.map((r) => `<div class="hbar"><span class="l" title="${esc(r.label)}">${esc(r.label)}</span><span class="t"><i style="width:${total ? (r.n / total) * 100 : 0}%"></i></span><span class="v">${r.n}</span></div>`).join('') || '<p class="muted">No data</p>';
async function dashboard(view) {
  const d = await api('/dashboard');
  const stat = (label, n, href, cls = '') => `<a class="card stat ${cls}" href="#${href}" style="color:inherit;text-decoration:none"><div class="muted">${label}</div><div class="n">${n}</div></a>`;
  const max = (a) => Math.max(1, ...a.map((x) => x.n));
  view.innerHTML = `<h1>Dashboard</h1><div class="grid g4">
    ${stat('Open requests', d.open, '/requests?open=1')}${stat('Overdue', d.overdue, '/requests?overdue=1', d.overdue ? 'bad' : '')}
    ${isMgr() ? stat('Awaiting approval', d.awaiting_approval, '/requests?status=Pending Approval', d.awaiting_approval ? 'warn' : '') + stat('To triage', d.to_triage, '/requests?status=Submitted,Triage') : ''}
    ${stat('Due in 7 days', d.due_7d, `/requests?open=1&due_from=${todayStr()}&due_to=${addDays(todayStr(), 7)}`)}</div>
    <div class="grid g2"><div class="card"><h2>By status</h2>${bars(d.by_status, max(d.by_status))}</div>
    <div class="card"><h2>Open by team</h2>${bars(d.by_team, max(d.by_team))}</div>
    <div class="card"><h2>Open by priority</h2>${bars(d.by_priority, max(d.by_priority))}</div>
    <div class="card"><h2>Open by site</h2>${bars(d.by_site, max(d.by_site))}</div></div>
    ${d.utilization ? `<div class="card"><h2>Utilization, next 4 weeks <span class="muted">(${d.utilization_range.from} → ${d.utilization_range.to})</span></h2>
      ${d.utilization.map((u) => { const p = u.capacity ? Math.round((u.booked / u.capacity) * 100) : (u.booked ? 999 : 0);
        return `<div class="hbar"><span class="l" title="${esc(u.name)} (${esc(u.team)})">${esc(u.name)}</span><span class="t"><i style="width:${Math.min(100, p)}%;background:${p > 100 ? 'var(--bad)' : p >= 80 ? 'var(--warn)' : 'var(--ok)'}"></i></span><span class="v">${u.booked}/${u.capacity}h</span></div>`; }).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------- requests list
async function requestList(view, q) {
  if (Object.keys(q).length) { S.filters = q; S.page = 0; }
  const f = S.filters; const M = S.meta; const PAGE = 25;
  view.innerHTML = `<div class="bar"><h1 style="margin:0">Requests</h1><span class="sp"></span><a class="btn primary" href="#/requests/new">+ New request</a>
    <a class="btn" id="csv" href="#">Export CSV</a></div>
    <form class="card filters" id="ff">
      <div><label>Search</label><input name="q" value="${esc(f.q || '')}" placeholder="Title, number, equipment…"></div>
      <div><label>Status</label><select name="status">${opts(M.statuses, f.status, { blank: 'All' })}${f.status && !M.statuses.includes(f.status) ? opts([f.status], f.status) : ''}</select></div>
      <div><label>Priority</label><select name="priority">${opts(M.priorities, f.priority, { blank: 'All' })}</select></div>
      <div><label>Site</label><select name="site_id">${opts(active(M.sites), f.site_id, { blank: 'All' })}</select></div>
      <div><label>Category</label><select name="category_id">${opts(active(M.categories), f.category_id, { blank: 'All' })}</select></div>
      <div><label>Assigned team</label><select name="team_id">${opts(active(M.teams), f.team_id, { blank: 'All' })}</select></div>
      ${M.resources ? `<div><label>Assigned to</label><select name="assignee_id">${opts(M.resources, f.assignee_id, { blank: 'All' })}</select></div>` : ''}
      ${isMgr() ? `<div><label>Requestor</label><select name="requestor_id">${opts(M.users, f.requestor_id, { blank: 'All' })}</select></div>` : ''}
      <div><label>Due from</label><input type="date" name="due_from" value="${esc(f.due_from || '')}"></div>
      <div><label>Due to</label><input type="date" name="due_to" value="${esc(f.due_to || '')}"></div>
      <div><label class="chk"><input type="checkbox" name="open" ${f.open === '1' ? 'checked' : ''}> Open only</label><label class="chk"><input type="checkbox" name="overdue" ${f.overdue === '1' ? 'checked' : ''}> Overdue</label></div>
      <div><button class="primary">Apply</button> <button type="button" id="clr">Clear</button></div></form>
    <div class="card tw" id="tbl"></div>`;
  const qs = () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(S.filters)) if (v) p.set(k, v); return p; };
  $('#ff').onsubmit = (e) => {
    e.preventDefault(); const o = {};
    for (const el of e.target.elements) if (el.name && (el.type === 'checkbox' ? el.checked : el.value)) o[el.name] = el.type === 'checkbox' ? '1' : el.value;
    S.filters = o; S.page = 0; load();
  };
  $('#clr').onclick = () => { S.filters = {}; S.page = 0; go('/requests'); };
  $('#csv').onclick = (e) => { e.preventDefault(); location.href = '/api/reports/requests.csv?' + qs(); };
  async function load() {
    const p = qs(); p.set('limit', PAGE); p.set('offset', S.page * PAGE); p.set('sort', S.sort); p.set('dir', S.dir);
    const d = await api('/requests?' + p);
    const th = (k, t) => `<th class="sort" data-s="${k}">${t}${S.sort === k ? (S.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    $('#tbl').innerHTML = `<table><thead><tr>${th('number', 'Number')}${th('title', 'Title')}${th('status', 'Status')}${th('priority', 'Priority')}${th('site', 'Site')}<th>Category</th>${th('team', 'Team')}<th>Assigned to</th>${th('due_date', 'Due')}</tr></thead>
      <tbody>${d.rows.map((r) => `<tr class="click" data-id="${r.id}"><td class="nowrap">${esc(r.number)}</td><td>${esc(r.title)}<div class="muted">${esc(r.equipment)}</div></td><td>${chip(r.status)}</td><td>${prio(r.priority)}</td>
        <td>${esc(r.site)}</td><td>${esc(r.category)}</td><td>${esc(r.team || '–')}</td><td>${esc(r.assignees || '–')}</td>
        <td class="nowrap ${r.due_date < todayStr() && !['Completed', 'Closed', 'Cancelled', 'Rejected'].includes(r.status) ? 'err' : ''}">${esc(r.due_date)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No requests match.</td></tr>'}</tbody></table>
      <div class="pager"><span class="muted">${d.total} request(s)</span><button class="sm" id="pv" ${S.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${S.page + 1} / ${Math.max(1, Math.ceil(d.total / PAGE))}</span><button class="sm" id="nx" ${(S.page + 1) * PAGE >= d.total ? 'disabled' : ''}>Next ›</button></div>`;
    $$('tr.click', $('#tbl')).forEach((tr) => (tr.onclick = () => (location.hash = `#/requests/${tr.dataset.id}`)));
    $$('th.sort', $('#tbl')).forEach((h) => (h.onclick = () => { S.dir = S.sort === h.dataset.s && S.dir === 'asc' ? 'desc' : 'asc'; S.sort = h.dataset.s; load(); }));
    $('#pv').onclick = () => { S.page--; load(); }; $('#nx').onclick = () => { S.page++; load(); };
  }
  await load();
}

// ---------------------------------------------------------------- request form
function requestForm(view) {
  const M = S.meta;
  view.innerHTML = `<h1>New request</h1><form class="card" id="rf" novalidate><div class="form">
    <div class="full"><label class="req">Title</label><input name="title" maxlength="200" required></div>
    <div class="full"><label class="req">Description</label><textarea name="description" maxlength="5000" required></textarea></div>
    <div><label class="req">Site / Location</label><select name="site_id" required>${opts(active(M.sites), '', { blank: 'Select…' })}</select></div>
    <div><label class="req">Equipment / Asset ID or name</label><input name="equipment" maxlength="200" required></div>
    <div><label class="req">Category</label><select name="category_id" required>${opts(active(M.categories), '', { blank: 'Select…' })}</select></div>
    <div><label class="req">Priority</label><select name="priority" required>${opts(M.priorities, 'Medium', { blank: 'Select…' })}</select></div>
    <div><label class="req">Requested due date</label><input type="date" name="due_date" min="${todayStr()}" required></div>
    <div><label>Safety impact</label><select name="safety_impact">${opts(M.safety, 'None')}</select></div>
    <div class="full"><label>Attachments (optional, max 5 files, 10 MB each)</label><input type="file" id="files" multiple></div>
    <div><label>Requestor</label><input value="${esc(S.me.name)}" disabled></div></div>
    <div class="err" id="fe" hidden></div><p><button class="primary">Submit request</button> <a class="btn" href="#/requests">Cancel</a></p></form>`;
  $('#rf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const err = $('#fe'); err.hidden = true;
    const body = Object.fromEntries([...new FormData(f)].filter(([, v]) => typeof v === 'string'));
    const miss = ['title', 'description', 'site_id', 'equipment', 'category_id', 'priority', 'due_date'].find((k) => !String(body[k] || '').trim());
    if (miss) { err.textContent = `Please fill in all mandatory fields (${miss.replace('_id', '').replace('_', ' ')}).`; err.hidden = false; return; }
    try {
      const r = await api('/requests', { method: 'POST', body });
      const files = $('#files').files;
      if (files.length) { const fd = new FormData(); [...files].forEach((x) => fd.append('files', x)); try { await api(`/requests/${r.id}/attachments`, { method: 'POST', form: fd }); } catch (ex) { toast(`Request created, but attachments failed: ${ex.message}`, true); } }
      toast(`Request ${r.number} submitted`); location.hash = `#/requests/${r.id}`;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

// ---------------------------------------------------------------- request detail
async function requestDetail(view, _q, id) {
  const r = await api(`/requests/${id}`); const M = S.meta; const m = isMgr();
  const late = r.due_date < todayStr() && ['Submitted', 'Triage', 'Pending Approval', 'Approved', 'Scheduled', 'In Progress', 'On Hold'].includes(r.status);
  const histText = (h) => { let d = {}; try { d = JSON.parse(h.detail || '{}'); } catch { /* ignore */ }
    const x = h.action === 'status_changed' ? `${d.from} → ${d.to}${d.auto ? ' (auto)' : ''}` : h.action === 'updated' ? Object.entries(d).map(([k, v]) => `${k}: ${v.from ?? '–'} → ${v.to ?? '–'}`).join('; ')
      : h.action.startsWith('assign') ? `${d.resource || ''} ${d.start || ''}${d.end ? ' → ' + d.end : ''} ${d.hours ? d.hours + 'h' : ''}` : d.filename || '';
    return `<li><b>${esc(h.action.replace(/_/g, ' '))}</b> ${esc(x)}<div class="muted">${esc(h.user || 'system')} · ${fmtTs(h.created_at)}</div></li>`; };
  view.innerHTML = `<div class="bar"><a href="#/requests">‹ Requests</a><span class="sp"></span>
      ${r.transitions.map((t) => `<button class="${['Approved', 'Closed', 'Completed'].includes(t.to) || t.label === 'Approve' ? 'primary' : ['Rejected', 'Cancelled'].includes(t.to) ? 'danger' : ''}" data-t="${esc(t.to)}" data-l="${esc(t.label)}" data-c="${t.comment ? 1 : 0}">${esc(t.label)}</button>`).join('')}
      ${r.editable ? '<button id="edit">Edit</button>' : ''}</div>
    <div class="card"><h1 style="margin-bottom:6px">${esc(r.number)} — ${esc(r.title)}</h1><div class="bar">${chip(r.status)} ${prio(r.priority)} ${r.safety_impact !== 'None' ? `<span class="chip">Safety: ${esc(r.safety_impact)}</span>` : ''}${late ? '<span class="chip s-Rejected">Overdue</span>' : ''}</div>
      <p style="white-space:pre-wrap">${esc(r.description)}</p>
      <dl class="kv"><div><dt>Site</dt><dd>${esc(r.site)}</dd></div><div><dt>Equipment / Asset</dt><dd>${esc(r.equipment)}</dd></div><div><dt>Category</dt><dd>${esc(r.category)}</dd></div>
      <div><dt>Requested due date</dt><dd>${esc(r.due_date)}</dd></div><div><dt>Requestor</dt><dd>${esc(r.requestor)}</dd></div><div><dt>Assigned team</dt><dd>${esc(r.team || '–')}</dd></div>
      <div><dt>Estimated hours</dt><dd>${r.estimated_hours ?? '–'}</dd></div><div><dt>Approver</dt><dd>${esc(r.approver || '–')}${r.decision_at ? ` · ${fmtTs(r.decision_at)}` : ''}</dd></div><div><dt>Created</dt><dd>${fmtTs(r.created_at)}</dd></div></dl></div>
    <div class="card"><div class="bar"><h2 style="margin:0">Assignments</h2><span class="sp"></span>${m && ['Approved', 'Scheduled', 'In Progress'].includes(r.status) ? '<button class="primary sm" id="addA">+ Assign resource</button>' : ''}</div>
      <div class="tw"><table><thead><tr><th>Resource</th><th>Start</th><th>End</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.assignments.map((a) => `<tr><td>${esc(a.resource)}</td><td>${a.start_date}</td><td>${a.end_date}</td><td>${a.planned_hours}</td><td>${esc(a.status)}</td>
        <td class="right">${m && a.status !== 'Cancelled' ? `<button class="sm" data-ea="${a.id}">Edit</button> <button class="sm danger" data-da="${a.id}">Cancel</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${r.status === 'Approved' ? 'Approved: ready to be assigned.' : 'No assignments.'}</td></tr>`}</tbody></table></div></div>
    <div class="grid g2"><div class="card"><h2>Attachments</h2>${r.attachments.map((a) => `<div><a href="/api/attachments/${a.id}">${esc(a.filename)}</a> <span class="muted">${(a.size / 1024).toFixed(0)} KB · ${esc(a.uploaded_by || '')}</span> <button class="sm danger" data-rm="${a.id}">✕</button></div>`).join('') || '<p class="muted">None</p>'}
      <p><input type="file" id="upl" multiple></p></div>
      <div class="card"><h2>Comments</h2>${r.comments.map((c) => `<div class="cmt">${esc(c.body)}<small>${esc(c.user)} · ${fmtTs(c.created_at)}</small></div>`).join('') || '<p class="muted">No comments yet.</p>'}
      <form id="cf" style="margin-top:10px"><textarea name="body" placeholder="Add a comment…" required></textarea><p><button class="primary sm">Post</button></p></form></div></div>
    <div class="card"><h2>History (audit trail)</h2><ul class="tl">${r.history.map(histText).join('')}</ul></div>`;

  $$('[data-t]', view).forEach((b) => (b.onclick = () => modal(b.dataset.l, `<p>${esc(r.number)}: <b>${esc(r.status)}</b> → <b>${esc(b.dataset.t === '@resume' ? 'previous status' : b.dataset.t)}</b></p>
    <label class="${b.dataset.c === '1' ? 'req' : ''}">Comment${b.dataset.c === '1' ? '' : ' (optional)'}</label><textarea name="comment"></textarea>`,
  { submit: b.dataset.l, onSubmit: async (v) => { await api(`/requests/${r.id}/transition`, { method: 'POST', body: { to: b.dataset.t, comment: v.comment } }); toast('Status updated'); route(); } })));
  $('#edit')?.addEventListener('click', () => editRequest(r));
  $('#addA')?.addEventListener('click', () => assignmentModal(r));
  $$('[data-ea]', view).forEach((b) => (b.onclick = () => assignmentModal(r, r.assignments.find((a) => a.id == b.dataset.ea))));
  $$('[data-da]', view).forEach((b) => (b.onclick = async () => { if (confirm('Cancel this assignment?')) { await api(`/assignments/${b.dataset.da}`, { method: 'DELETE' }); toast('Assignment cancelled'); route(); } }));
  $$('[data-rm]', view).forEach((b) => (b.onclick = async () => { if (confirm('Remove this attachment?')) { await api(`/attachments/${b.dataset.rm}`, { method: 'DELETE' }); route(); } }));
  $('#upl').onchange = async (e) => { const fd = new FormData(); [...e.target.files].forEach((x) => fd.append('files', x)); try { await api(`/requests/${r.id}/attachments`, { method: 'POST', form: fd }); toast('Uploaded'); route(); } catch (ex) { toast(ex.message, true); } };
  $('#cf').onsubmit = async (e) => { e.preventDefault(); await api(`/requests/${r.id}/comments`, { method: 'POST', body: { body: e.target.body.value } }).catch((x) => toast(x.message, true)); route(); };
}

function editRequest(r) {
  const M = S.meta; const m = isMgr();
  modal(`Edit ${r.number}`, `<div class="form"><div class="full"><label class="req">Title</label><input name="title" value="${esc(r.title)}"></div>
    <div class="full"><label class="req">Description</label><textarea name="description">${esc(r.description)}</textarea></div>
    <div><label>Site</label><select name="site_id">${opts(active(M.sites), r.site_id)}</select></div><div><label>Equipment / Asset</label><input name="equipment" value="${esc(r.equipment)}"></div>
    <div><label>Category</label><select name="category_id">${opts(active(M.categories), r.category_id)}</select></div><div><label>Priority</label><select name="priority">${opts(M.priorities, r.priority)}</select></div>
    <div><label>Due date</label><input type="date" name="due_date" value="${esc(r.due_date)}"></div>
    ${m ? `<div><label>Assigned team</label><select name="team_id">${opts(active(M.teams), r.team_id, { blank: '– none –' })}</select></div>
      <div><label>Estimated hours</label><input type="number" min="0" step="0.5" name="estimated_hours" value="${r.estimated_hours ?? ''}"></div>
      <div><label>Safety impact</label><select name="safety_impact">${opts(M.safety, r.safety_impact)}</select></div>` : ''}</div>`,
  { wide: true, onSubmit: async (v) => { await api(`/requests/${r.id}`, { method: 'PATCH', body: v }); toast('Saved'); route(); } });
}

function assignmentModal(r, a) {
  const M = S.meta; const res = active(M.resources);
  const sorted = [...res].sort((x, y) => (y.team_id === r.team_id) - (x.team_id === r.team_id) || x.name.localeCompare(y.name));
  const start = a?.start_date || (todayStr() > r.due_date ? todayStr() : todayStr());
  modal(a ? 'Edit assignment' : `Assign resource to ${r.number}`, `<div class="form"><div class="full"><label class="req">Resource</label><select name="resource_id">${opts(sorted.map((x) => ({ id: x.id, name: `${x.name} — ${M.teams.find((t) => t.id === x.team_id)?.name}${x.team_id === r.team_id ? ' ★' : ''}` })), a?.resource_id)}</select></div>
    <div><label class="req">Start date</label><input type="date" name="start_date" value="${start}"></div><div><label class="req">End date</label><input type="date" name="end_date" value="${a?.end_date || (r.due_date >= start ? r.due_date : start)}"></div>
    <div><label class="req">Planned hours</label><input type="number" min="0.5" step="0.5" name="planned_hours" value="${a?.planned_hours ?? r.estimated_hours ?? ''}"></div>
    <div class="full"><label>Notes</label><input name="notes" value="${esc(a?.notes || '')}"></div></div>
    <p class="muted">★ = resource of the assigned team. Hours are spread across working days (Mon–Fri) of the range.</p>`,
  { onSubmit: async (v) => {
    const send = (force) => api(a ? `/assignments/${a.id}` : `/requests/${r.id}/assignments`, { method: a ? 'PATCH' : 'POST', body: { ...v, force } });
    try { await send(false); } catch (e) {
      if (e instanceof ApiError && e.data?.code === 'OVERBOOKED' && confirm(`${e.message}\n\nAssign anyway?`)) await send(true); else throw e;
    }
    toast('Assignment saved'); route(); } });
}

// ---------------------------------------------------------------- Gantt views
function ganttControls(g, extra, onChange) {
  return `<div class="bar"><div>${['day', 'week', 'month'].map((z) => `<button class="sm ${g.zoom === z ? 'on' : ''}" data-z="${z}">${z[0].toUpperCase() + z.slice(1)}</button>`).join(' ')}</div>
    <button class="sm" data-n="-1">‹ Prev</button><button class="sm" data-n="0">Today</button><button class="sm" data-n="1">Next ›</button>
    <input type="date" id="gf" value="${g.from || ''}" style="width:auto"><span class="sp"></span>${extra}</div>`;
}
function bindGantt(view, g, reload) {
  $$('[data-z]', view).forEach((b) => (b.onclick = () => { g.zoom = b.dataset.z; g.from = startFor(g.from || todayStr(), g.zoom); reload(); }));
  $$('[data-n]', view).forEach((b) => (b.onclick = () => { const n = +b.dataset.n; g.from = n === 0 ? startFor(todayStr(), g.zoom) : shiftFrom(g.from, g.zoom, n); reload(); }));
  $('#gf', view).onchange = (e) => { if (e.target.value) { g.from = startFor(e.target.value, g.zoom); reload(); } };
  $$('[data-f]', view).forEach((s) => (s.onchange = () => { g[s.dataset.f] = s.value; reload(); }));
}
const legend = `<div class="legend"><span><i style="background:var(--p-low)"></i>Low</span><span><i style="background:var(--p-med)"></i>Medium</span><span><i style="background:var(--p-high)"></i>High</span><span><i style="background:var(--p-crit)"></i>Critical</span>
  <span><i style="background:repeating-linear-gradient(45deg,var(--hatch) 0 3px,transparent 3px 6px)"></i>Unavailable</span><span><i class="u-ok"></i>&lt;80% load</span><span><i class="u-warn"></i>80–100%</span><span><i class="u-over"></i>&gt;100%</span><span>Red line = today</span></div>`;

async function ganttResources(view) {
  const g = S.gantt; const M = S.meta;
  if (!g.from) g.from = startFor(todayStr(), g.zoom);
  const draw = async () => {
    const p = new URLSearchParams({ zoom: g.zoom, from: g.from }); if (g.team_id) p.set('team_id', g.team_id); if (g.site_id) p.set('site_id', g.site_id); if (g.scope) p.set('scope', 'mine');
    const d = await api('/gantt/resources?' + p); g.from = d.from;
    const rows = d.rows.map((r) => ({ name: r.name, sub: `${r.team}${r.site ? ' · ' + r.site : ''} · ${r.weekly_capacity_hours}h/wk`,
      bars: r.assignments.map((a) => ({ start: a.start_date, end: a.end_date, label: `${a.number} ${a.title}`, href: `#/requests/${a.request_id}`, cls: `p-${a.priority}${a.status === 'Done' ? ' done' : ''}`, title: `${a.number} ${a.title}\n${a.start_date} → ${a.end_date} · ${a.planned_hours}h · ${a.status}` })),
      unav: r.unavailability.map((u) => ({ start: u.start_date, end: u.end_date, title: `Unavailable ${u.start_date} → ${u.end_date}${u.reason ? ' · ' + u.reason : ''}` })), caps: r.buckets }));
    view.innerHTML = `<h1>Gantt by Resource <span class="muted" style="font-size:13px">— who is booked when</span></h1>` +
      ganttControls(g, `<select data-f="team_id" style="width:auto">${opts(active(M.teams), g.team_id, { blank: 'All teams' })}</select><select data-f="site_id" style="width:auto">${opts(active(M.sites), g.site_id, { blank: 'All sites' })}</select>
        ${S.me.role === 'technician' ? `<select data-f="scope" style="width:auto"><option value="">Everyone</option><option value="mine" ${g.scope ? 'selected' : ''}>Only me</option></select>` : ''}`) +
      legend + renderGantt({ from: d.from, to: d.to, zoom: d.zoom, rows, today: todayStr() });
    bindGantt(view, g, () => draw().catch((e) => toast(e.message, true)));
  };
  await draw();
}

async function ganttRequests(view) {
  const g = S.gantt; const M = S.meta;
  if (!g.from) g.from = startFor(todayStr(), g.zoom);
  const draw = async () => {
    const p = new URLSearchParams({ zoom: g.zoom, from: g.from }); if (g.team_id) p.set('team_id', g.team_id); if (g.site_id) p.set('site_id', g.site_id);
    const d = await api('/gantt/requests?' + p); g.from = d.from;
    const rows = d.rows.map((r) => ({ nameHtml: `<a href="#/requests/${r.id}"><b>${esc(r.number)}</b></a> ${chip(r.status)}`, sub: `${r.title} · ${r.site}${r.team ? ' · ' + r.team : ''}`, due: r.due_date,
      bars: r.assignments.map((a) => ({ start: a.start_date, end: a.end_date, label: `${a.resource} · ${a.planned_hours}h`, href: `#/requests/${r.id}`, cls: `p-${r.priority}${a.status === 'Done' ? ' done' : ''}`, title: `${a.resource}\n${a.start_date} → ${a.end_date} · ${a.planned_hours}h · ${a.status}` })) }));
    view.innerHTML = `<h1>Gantt by Request <span class="muted" style="font-size:13px">— timeline and assignments per request</span></h1>` +
      ganttControls(g, `<select data-f="team_id" style="width:auto">${opts(active(M.teams), g.team_id, { blank: 'All teams' })}</select><select data-f="site_id" style="width:auto">${opts(active(M.sites), g.site_id, { blank: 'All sites' })}</select>`) +
      legend.replace('Red line = today', 'Red line = today · ◆ = requested due date') + (d.truncated ? '<div class="warnbox">Showing the first 300 requests. Narrow the filters or the date range.</div>' : '') +
      renderGantt({ from: d.from, to: d.to, zoom: d.zoom, rows, today: todayStr() });
    bindGantt(view, g, () => draw().catch((e) => toast(e.message, true)));
  };
  await draw();
}

// ---------------------------------------------------------------- resources
async function resourcesPage(view) {
  const rs = await api('/resources'); const M = S.meta; const m = isMgr();
  view.innerHTML = `<div class="bar"><h1 style="margin:0">Resources</h1><span class="sp"></span>${m ? '<button class="primary" id="addR">+ Add resource</button>' : ''}</div>
    <div class="card tw"><table><thead><tr><th>Name</th><th>Team</th><th>Site</th><th>Capacity (h/week)</th><th>Skills</th><th>Login</th><th>Active</th><th></th></tr></thead><tbody>
    ${rs.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.team)}</td><td>${esc(r.site || '–')}</td><td>${r.weekly_capacity_hours}</td><td>${esc(r.skills || '')}</td><td>${esc(r.user_email || '–')}</td><td>${r.active ? 'Yes' : 'No'}</td>
      <td class="right nowrap"><button class="sm" data-u="${r.id}">Unavailability</button>${m ? ` <button class="sm" data-e="${r.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const form = (r = {}) => `<div class="form"><div><label class="req">Name</label><input name="name" value="${esc(r.name || '')}"></div>
    <div><label class="req">Team</label><select name="team_id">${opts(active(M.teams), r.team_id)}</select></div><div><label>Site</label><select name="site_id">${opts(active(M.sites), r.site_id, { blank: '–' })}</select></div>
    <div><label class="req">Weekly capacity (hours)</label><input type="number" min="0" max="80" step="0.5" name="weekly_capacity_hours" value="${r.weekly_capacity_hours ?? 40}"></div>
    <div><label>Linked user (login)</label><select name="user_id">${opts((M.users || []).filter((u) => u.role === 'technician' || u.role === 'dispatch_manager'), r.user_id, { blank: '–' })}</select></div>
    <div><label>Skills</label><input name="skills" value="${esc(r.skills || '')}"></div>${r.id ? `<div><label class="chk"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Active</label></div>` : ''}</div>`;
  $('#addR')?.addEventListener('click', () => modal('Add resource', form(), { wide: true, onSubmit: async (v) => { delete v.active; await api('/resources', { method: 'POST', body: v }); S.meta = await api('/meta'); route(); } }));
  $$('[data-e]', view).forEach((b) => (b.onclick = () => { const r = rs.find((x) => x.id == b.dataset.e);
    modal(`Edit ${r.name}`, form(r), { wide: true, onSubmit: async (v) => { await api(`/resources/${r.id}`, { method: 'PATCH', body: v }); S.meta = await api('/meta'); route(); } }); }));
  $$('[data-u]', view).forEach((b) => (b.onclick = () => unavailModal(rs.find((x) => x.id == b.dataset.u), m)));
}

async function unavailModal(r, canEdit) {
  const list = await api(`/unavailability?resource_id=${r.id}&from=${addDays(todayStr(), -30)}`);
  const body = `<table><thead><tr><th>From</th><th>To</th><th>Reason</th><th></th></tr></thead><tbody>${list.map((u) => `<tr><td>${u.start_date}</td><td>${u.end_date}</td><td>${esc(u.reason || '')}</td>
    <td>${canEdit ? `<button type="button" class="sm danger" data-d="${u.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No upcoming unavailability.</td></tr>'}</tbody></table>
    ${canEdit ? `<h3 style="margin-top:14px">Add unavailability (all-day range)</h3><div class="form"><div><label class="req">Start</label><input type="date" name="start_date"></div><div><label class="req">End</label><input type="date" name="end_date"></div><div><label>Reason</label><input name="reason" placeholder="Leave, training…"></div></div>` : ''}`;
  modal(`Unavailability — ${r.name}`, body, { wide: true, hideActions: !canEdit, submit: 'Add',
    onOpen: (ov, close) => $$('[data-d]', ov).forEach((b) => (b.onclick = async () => { await api(`/unavailability/${b.dataset.d}`, { method: 'DELETE' }); close(); unavailModal(r, canEdit); })),
    onSubmit: async (v) => { const x = await api('/unavailability', { method: 'POST', body: { ...v, resource_id: r.id } });
      toast(x.conflicting_assignments ? `Saved. Warning: ${x.conflicting_assignments} existing assignment(s) overlap this period.` : 'Saved', !!x.conflicting_assignments); } });
}

// ---------------------------------------------------------------- admin
async function adminPage(view) {
  const [users] = await Promise.all([api('/admin/users')]); const M = S.meta = await api('/meta');
  const refs = (key, title) => `<div class="card"><h2>${title}</h2>${M[key].map((x) => `<div class="bar" style="margin:4px 0"><span style="flex:1">${esc(x.name)}${x.active ? '' : ' <span class="muted">(inactive)</span>'}</span>
    <button class="sm" data-rn="${key}:${x.id}">Rename</button><button class="sm" data-rt="${key}:${x.id}:${x.active ? 0 : 1}">${x.active ? 'Deactivate' : 'Activate'}</button></div>`).join('')}
    <form data-add="${key}" class="bar" style="margin-top:8px"><input name="name" placeholder="New ${title.toLowerCase().replace(/s$/, '')}…" required><button class="primary sm">Add</button></form></div>`;
  view.innerHTML = `<h1>Administration</h1><div class="card tw"><div class="bar"><h2 style="margin:0">Users</h2><span class="sp"></span><button class="primary sm" id="addU">+ Add user</button></div>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Active</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${ROLE_LABEL[u.role]}</td><td>${esc(u.team || '–')}</td><td>${u.active ? 'Yes' : 'No'}</td>
    <td class="right"><button class="sm" data-eu="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
    <div class="grid g2">${refs('sites', 'Sites')}${refs('teams', 'Teams')}${refs('categories', 'Categories')}</div>`;
  const uform = (u = {}) => `<div class="form"><div><label class="req">Name</label><input name="name" value="${esc(u.name || '')}"></div>${u.id ? '' : `<div><label class="req">Email</label><input type="email" name="email"></div>`}
    <div><label class="req">Role</label><select name="role">${opts(Object.entries(ROLE_LABEL).map(([id, name]) => ({ id, name })), u.role || 'requestor')}</select></div>
    <div><label>Team (technicians)</label><select name="team_id">${opts(active(M.teams), u.team_id, { blank: '–' })}</select></div>
    <div><label${u.id ? '' : ' class="req"'}>${u.id ? 'Reset password (optional)' : 'Initial password (min. 10)'}</label><input type="password" name="password" autocomplete="new-password"></div>
    ${u.id ? `<div><label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label></div>` : ''}</div>`;
  $('#addU').onclick = () => modal('Add user', uform(), { wide: true, onSubmit: async (v) => { delete v.active; await api('/admin/users', { method: 'POST', body: v }); route(); } });
  $$('[data-eu]', view).forEach((b) => (b.onclick = () => { const u = users.find((x) => x.id == b.dataset.eu);
    modal(`Edit ${u.name}`, uform(u), { wide: true, onSubmit: async (v) => { if (!v.password) delete v.password; await api(`/admin/users/${u.id}`, { method: 'PATCH', body: v }); route(); } }); }));
  $$('[data-add]', view).forEach((f) => (f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/admin/${f.dataset.add}`, { method: 'POST', body: { name: f.name.value } }); route(); } catch (ex) { toast(ex.message, true); } }));
  $$('[data-rn]', view).forEach((b) => (b.onclick = async () => { const [k, id] = b.dataset.rn.split(':'); const n = prompt('New name'); if (n) { await api(`/admin/${k}/${id}`, { method: 'PATCH', body: { name: n } }); route(); } }));
  $$('[data-rt]', view).forEach((b) => (b.onclick = async () => { const [k, id, a] = b.dataset.rt.split(':'); await api(`/admin/${k}/${id}`, { method: 'PATCH', body: { active: a === '1' } }); route(); }));
}

boot();
