export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => fmtD(parseD(s) + n * 864e5);
export const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
export const todayStr = () => fmtD(Date.now());
export const mondayOf = (s) => addDays(s, -((new Date(parseD(s)).getUTCDay() + 6) % 7));

export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
export async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (form) opt.body = form; else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opt);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export function toast(msg, bad = false) {
  const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

export const opts = (items, sel, { value = 'id', text = 'name', blank } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
  items.map((i) => { const v = typeof i === 'object' ? i[value] : i; const t = typeof i === 'object' ? i[text] : i;
    return `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(t)}</option>`; }).join('');

export const chip = (status) => `<span class="chip s-${esc(String(status).split(' ')[0])}">${esc(status)}</span>`;
export const prio = (p) => `<span class="p-${esc(p)}">${esc(p)}</span>`;
export const fmtTs = (ts) => (ts ? ts.replace('T', ' ').slice(0, 16) : '');

export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'file') continue;
    else o[el.name] = el.value;
  }
  return o;
}

// Modal helper. onSubmit(values, form) may throw to show an inline error; resolving closes the modal.
export function modal(title, bodyHtml, { submit = 'Save', onSubmit, wide = false, onOpen, hideActions = false } = {}) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<form class="modal${wide ? ' wide' : ''}" novalidate><h2>${esc(title)}</h2><div class="mbody">${bodyHtml}</div><div class="err" hidden></div>
    <div class="acts"><button type="button" data-close>${hideActions ? 'Close' : 'Cancel'}</button>${hideActions ? '' : `<button class="primary" type="submit">${esc(submit)}</button>`}</div></form>`;
  document.body.append(ov);
  const form = $('form', ov); const err = $('.err', ov);
  const close = () => ov.remove();
  $('[data-close]', ov).onclick = close;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  form.onsubmit = async (e) => {
    e.preventDefault(); err.hidden = true;
    const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
    try { await onSubmit?.(formData(form), form); close(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; if (btn) btn.disabled = false; }
  };
  onOpen?.(ov, close);
  const first = $('input:not([type=hidden]),select,textarea', form); first?.focus();
  return { close, el: ov };
}
