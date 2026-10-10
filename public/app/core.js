// ============================================================
// Core: auth + API, shared state, formatting, toasts, modals, actions
// ============================================================
export const TOKEN_KEY = 'jd_token';
const USER_KEY = 'jd_username';

export const state = {
    user: null,
    cases: [],
    forms: [],
    caseView: null,
    caseId: null,
    tab: 'overview',
    route: [],
    copilotOpen: true,
    docSel: null,
    schemaProblem: null
};

// ---------- tiny event bus ----------
const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
export function emit(evt, data) { (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

// ---------- click actions: <button data-act="name" data-x="..."> ----------
const actions = {};
export function action(name, fn) { actions[name] = fn; }
export function runAction(name, data = {}) { if (actions[name]) actions[name](data, null, null); }
document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    if (el.dataset.stop !== undefined) e.stopPropagation();
    fn(el.dataset, el, e);
});

// ---------- auth ----------
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } };
export const authHeaders = () => (getToken() ? { Authorization: 'Bearer ' + getToken() } : {});

export async function signIn(username, password) {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) throw new Error(d.error || 'Invalid credentials.');
    localStorage.setItem(TOKEN_KEY, d.token);
    localStorage.setItem(USER_KEY, d.username || username);
}

export async function signOut() {
    try { await authFetch('/api/logout', { method: 'POST' }); } catch (_) {}
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
}

export async function authFetch(url, opts = {}) {
    opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
    const res = await fetch(url, opts);
    if (res.status === 401) {
        try {
            const check = await (await fetch('/api/auth-status', { headers: authHeaders() })).json();
            if (check.authenticated) { const retry = await fetch(url, opts); if (retry.status !== 401) return retry; }
        } catch (_) {}
        localStorage.removeItem(TOKEN_KEY);
        emit('logged-out');
        throw new Error('Session expired — sign in again');
    }
    return res;
}

// JSON request; throws with the server's message (error.data has the body)
export async function api(url, opts = {}) {
    if (opts.json !== undefined) {
        opts.method = opts.method || 'POST';
        opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        opts.body = JSON.stringify(opts.json);
        delete opts.json;
    }
    const r = await authFetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || `Request failed (${r.status})`); e.data = d; e.status = r.status; throw e; }
    return d;
}

// ---------- formatting ----------
export function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseISO(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
export function fmtDate(s, { short = false } = {}) {
    const d = parseISO(s);
    if (!d) return s || '';
    return short ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
export function fmtMoney(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? String(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function relDays(n) {
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n < 0 ? `${-n} days ago` : `in ${n} days`;
}
export function ago(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return fmtDate(String(iso).slice(0, 10));
}
export function bytes(n) { if (!n) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
export function caseLabel(c) { return `${c.debtorName || 'Unnamed'}${c.caseNumber ? ' · ' + c.caseNumber : ''}`; }
export function varLabel(v) { const t = String(v).replace(/^\[|\]$/g, '').replace(/^VAR_/, '').replace(/_/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }
export function dateBox(s) {
    const d = parseISO(s);
    return d ? `<div class="datebox"><span>${MONTHS[d.getMonth()]}</span><b>${d.getDate()}</b></div>` : '<div class="datebox"></div>';
}
export function statusChip(st) {
    const t = { overdue: 'Overdue', soon: 'Due soon', upcoming: 'Upcoming', done: 'Done' }[st] || st;
    return `<span class="chip ${esc(st)}">${esc(t)}</span>`;
}

// AI text → safe HTML: bold, headings, bullets, [[form:case:form|label]] buttons
export function formatAi(text) {
    let h = esc(text);
    h = h.replace(/\[\[form:([0-9a-f-]{36}):([0-9a-f-]{36})\|([^\]]+)\]\]/g, (_, c, f, l) =>
        `<button class="form-chip" data-act="show-form" data-case="${c}" data-form="${f}">${icon('file')} ${l}</button>`);
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/^#{1,4} (.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^\s*[-•*] (.+)$/gm, '<span class="li"><i></i><span>$1</span></span>');
    return h;
}

// ---------- icons (inline SVG, stroke = currentColor) ----------
const ICONS = {
    today: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    cases: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    calendar: 'M8 7V3m8 4V3M3 11h18M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
    report: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    chat: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    file: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
    upload: 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12',
    plus: 'M12 4v16m8-8H4',
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    out: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
    edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    sun: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    moon: 'M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z',
    arrow: 'M13 7l5 5m0 0l-5 5m5-5H6',
    warn: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    check: 'M5 13l4 4L19 7',
    x: 'M6 18L18 6M6 6l12 12',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    panel: 'M4 6h16M4 12h16M4 18h7',
    eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
    download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
    refresh: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    sparkle: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
    note: 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
    clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    gavel: 'M3 21h8M7 17l4-4m3-9l6 6-4 4-6-6 4-4zm-2 6l-6 6'
};
export function icon(name, cls = '') {
    return `<svg class="ic ${cls}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="${ICONS[name] || ''}"/></svg>`;
}

// ---------- toasts ----------
export function toast(msg, kind = 'ok', ms) {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms || (kind === 'ok' ? 3500 : 7000));
}

// ---------- modal ----------
export function modal(title, body, foot = '', { wide = false } = {}) {
    document.getElementById('modalRoot').innerHTML = `
        <div class="modal-bg" data-modal-bg>
            <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label="${esc(title)}">
                <div class="modal-h"><span>${esc(title)}</span><button class="btn ghost sm" data-act="close-modal" aria-label="Close">${icon('x')}</button></div>
                <div class="modal-b">${body}</div>
                ${foot ? `<div class="modal-f">${foot}</div>` : ''}
            </div>
        </div>`;
    const first = document.querySelector('#modalRoot input, #modalRoot textarea, #modalRoot select');
    if (first) setTimeout(() => first.focus(), 30);
}
export function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
action('close-modal', closeModal);
document.addEventListener('mousedown', e => { if (e.target.matches('[data-modal-bg]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); emit('escape'); } });

// Open a URL from an API that returns either JSON {url} or the file bytes
export async function openFile(url, { inline = true, name = 'file' } = {}) {
    const w = inline ? window.open('', '_blank') : null;
    try {
        const r = await authFetch(url);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not open the file');
        if ((r.headers.get('content-type') || '').includes('application/json')) {
            const { url: signed } = await r.json();
            if (w) w.location = signed; else window.location.href = signed;
            return;
        }
        const href = URL.createObjectURL(await r.blob());
        if (w) { w.location = href; return; }
        const cd = (r.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
        const a = document.createElement('a');
        a.href = href; a.download = cd ? decodeURIComponent(cd[1]) : name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 30000);
    } catch (e) {
        if (w) w.close();
        toast(e.message, 'err');
    }
}

// URL usable in an <iframe> for a document (signed URL, or a blob in file mode)
export async function viewUrl(url) {
    const r = await authFetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load the file');
    if ((r.headers.get('content-type') || '').includes('application/json')) return (await r.json()).url;
    return URL.createObjectURL(await r.blob());
}

export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
