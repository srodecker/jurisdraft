// ============================================================
// Kinecta Case Manager — app shell, router, copilot
// ============================================================
import { state, api, esc, icon, toast, modal, closeModal, action, on, getToken, authHeaders, signIn, signOut, caseLabel } from './core.js';
import { refreshStatus, renderActivity } from './queue.js';
import { chatMarkup, mountChat } from './chat.js';
import { openPalette } from './palette.js';
import { renderToday } from './views/today.js';
import { renderCases } from './views/cases.js';
import { renderCase } from './views/case.js';
import { renderFormsCatalog } from './views/forms.js';
import { renderSettings } from './views/settings.js';
import { renderCalendar } from './views/calendar.js';
import { renderReports } from './views/reports.js';

// ---------- theme ----------
function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('jd_theme', t); } catch (_) {}
    const b = document.getElementById('themeBtn');
    if (b) b.innerHTML = `${icon(t === 'dark' ? 'sun' : 'moon')}<span>${t === 'dark' ? 'Light mode' : 'Dark mode'}</span>`;
}
action('theme', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// ---------- cases cache (nav badge, palette, jump) ----------
export function setCases(list) {
    state.cases = list || [];
    const overdue = state.cases.reduce((n, c) => n + (c.overdueCount || 0), 0);
    const b = document.getElementById('navOverdue');
    if (b) { b.textContent = overdue; b.classList.toggle('hidden', !overdue); }
}
export async function loadCases() {
    try { setCases(await api('/api/cases')); } catch (_) {}
    return state.cases;
}

export function setCrumbs(parts) {
    const el = document.getElementById('crumbs');
    if (el) el.innerHTML = parts.map((p, i) => i === parts.length - 1 ? `<b>${esc(p[0])}</b>` : `<a href="${p[1]}">${esc(p[0])}</a>`).join(' <span class="muted">/</span> ');
}

// ---------- layout ----------
const NAV = [
    ['today', 'Today', 'today'], ['cases', 'Cases', 'cases'], ['calendar', 'Calendar', 'calendar'],
    ['reports', 'Client report', 'report'], ['assistant', 'Assistant', 'chat'], ['forms', 'Forms', 'file']
];

function renderShell() {
    document.getElementById('root').innerHTML = `
    <div class="shell">
        <nav class="rail">
            <div class="brand"><div class="logo">${icon('gavel')}</div><div><b>JurisDraft</b><span>Kinecta Case Manager</span></div></div>
            <div class="nav">${NAV.map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}" title="${l}">${icon(i)}<span>${l}</span>${k === 'today' ? '<b class="count hidden" id="navOverdue"></b>' : ''}</a>`).join('')}</div>
            <div class="nav-label">Tools</div>
            <div class="nav"><a href="/full" title="Doc Generator">${icon('edit')}<span>Doc Generator</span></a><a href="#/settings" data-nav="settings" title="Settings">${icon('settings')}<span>Settings</span></a></div>
            <div class="rail-foot">
                <div class="nav">
                    <a href="#" data-act="theme" id="themeBtn"></a>
                    <a href="#" data-act="sign-out">${icon('out')}<span>Sign out</span></a>
                </div>
                <div class="who">${esc(state.user || '')}</div>
            </div>
        </nav>
        <div class="main">
            <header class="topbar">
                <div class="crumbs" id="crumbs"></div>
                <div class="activity" id="activity"></div>
                <div class="kbar" data-act="open-palette" role="button" tabindex="0">${icon('search')}<span>Search cases or ask…</span><kbd>Ctrl K</kbd></div>
                <button class="btn primary" data-act="new-case">${icon('plus')}<span>New case</span></button>
            </header>
            <div class="body">
                <main class="content" id="content"><div class="page" id="view"></div></main>
                <aside class="copilot hidden" id="copilot"></aside>
            </div>
        </div>
    </div>`;
    applyTheme(document.documentElement.dataset.theme || 'dark');
}

// ---------- router ----------
async function route() {
    const parts = (location.hash || '#/today').replace(/^#\/?/, '').split('/');
    const [page, id, tab, sub] = parts;
    state.route = parts;
    closeModal();
    const view = document.getElementById('view');
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (page === 'case' ? 'cases' : page || 'today')));
    if (page !== 'case') { state.caseId = null; state.caseView = null; }
    renderCopilot();
    const content = document.getElementById('content');
    try {
        if (page === 'case' && id) { await renderCase(view, id, tab || 'overview', sub); return; }
        content.scrollTop = 0;
        if (page === 'cases') { setCrumbs([['Cases']]); await renderCases(view); }
        else if (page === 'assistant') { setCrumbs([['Assistant']]); renderAssistantPage(view); }
        else if (page === 'forms') { setCrumbs([['Forms']]); await renderFormsCatalog(view); }
        else if (page === 'calendar') { setCrumbs([['Calendar']]); await renderCalendar(view); }
        else if (page === 'reports') { setCrumbs([['Client report']]); await renderReports(view); }
        else if (page === 'settings') { setCrumbs([['Settings']]); await renderSettings(view); }
        else { setCrumbs([['Today']]); await renderToday(view); }
    } catch (e) {
        console.error(e);
        view.innerHTML = `<div class="empty"><div class="big">Something went wrong</div>${esc(e.message)}</div>`;
    }
}
window.addEventListener('hashchange', route);
action('go', d => { location.hash = d.href; });

// ---------- assistant (page + case copilot) ----------
function renderAssistantPage(view) {
    view.innerHTML = `<div class="pagehead"><div><h1 class="h1">Assistant</h1><p class="sub">Knows every case and its documents · can update facts, add reminders and prepare forms</p></div>
        <div class="right"><button class="btn ghost sm" data-act="chat-clear" data-id="g">Clear conversation</button></div></div>${chatMarkup('g', { page: true, placeholder: 'Ask about any case, or tell me what to do…' })}`;
    const initial = state.pendingAsk; state.pendingAsk = null;
    mountChat('g', null, ['What needs my attention today?', 'Which cases are ready for a default request?', 'Write a status update on every active case', 'What hearings are coming up?'], { initial });
}

export function renderCopilot() {
    const el = document.getElementById('copilot');
    if (!el) return;
    const show = !!(state.caseId && state.copilotOpen);
    el.classList.toggle('hidden', !show);
    if (!show) return;
    if (el.dataset.case === state.caseId && el.innerHTML) return;
    el.dataset.case = state.caseId;
    el.innerHTML = `<div class="copilot-h">${icon('sparkle')}<span>Case assistant</span><div class="r"><button class="btn ghost sm" data-act="chat-clear" data-id="c">Clear</button><button class="btn ghost sm icon" data-act="toggle-copilot" title="Close">${icon('x')}</button></div></div>${chatMarkup('c', { placeholder: 'Ask about this case or say what to do…' })}`;
    const s = state.caseView ? state.caseView.stage.key : '';
    const sugg = ['Summarize this case', 'What is the next step and its deadline?', 'When and how was the defendant served?'];
    if (s === 'default_window') sugg.push('Prepare the request for entry of default');
    if (s === 'default_entered') sugg.push('Prepare the request for court judgment');
    if (s === 'judgment') sugg.push('Prepare the abstract of judgment');
    mountChat('c', state.caseId, sugg);
}
action('toggle-copilot', () => {
    state.copilotOpen = !state.copilotOpen;
    try { localStorage.setItem('jd_copilot', state.copilotOpen ? '1' : '0'); } catch (_) {}
    renderCopilot();
    const btn = document.querySelector('[data-act="toggle-copilot"].btn:not(.icon)');
    if (btn) btn.outerHTML = `<button class="btn ${state.copilotOpen ? 'secondary' : 'primary'}" data-act="toggle-copilot">${icon('sparkle')}${state.copilotOpen ? 'Hide AI' : 'Ask AI'}</button>`;
});

// ---------- new case ----------
action('new-case', () => {
    modal('New case', `<div class="fgrid">
            <div class="full"><label class="lbl">Defendant / debtor name *</label><input class="input" id="ncName" placeholder="e.g. Erick Alonso Acevedo"></div>
            <div class="full"><label class="lbl">Case number (if filed)</label><input class="input" id="ncNumber"></div>
            <div class="full muted">Everything else fills in from the documents you upload next.</div></div>`,
        `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="create-case">Create case</button>`);
    document.getElementById('ncNumber').addEventListener('keydown', e => { if (e.key === 'Enter') createCase(); });
    document.getElementById('ncName').addEventListener('keydown', e => { if (e.key === 'Enter') createCase(); });
});
async function createCase() {
    const name = document.getElementById('ncName').value.trim();
    if (!name) return toast('Enter the defendant name', 'warn');
    try {
        const m = await api('/api/cases', { json: { debtorName: name, caseNumber: document.getElementById('ncNumber').value.trim() } });
        closeModal();
        await loadCases();
        location.hash = `#/case/${m.id}/documents`;
    } catch (e) { toast(e.message, 'err'); }
}
action('create-case', createCase);
action('sign-out', signOut);

on('cases-changed', () => loadCases());
on('logged-out', () => showLogin());

// ---------- login ----------
function showLogin(message = '') {
    document.getElementById('root').innerHTML = `<div class="login"><form class="login-card" id="loginForm">
        <div class="logo">${icon('gavel')}</div><h1>Kinecta Case Manager</h1><p>Sign in to continue</p>
        <input class="input" id="lu" placeholder="Username" autocomplete="username">
        <input class="input" id="lp" type="password" placeholder="Password" autocomplete="current-password">
        <div id="le" class="small" style="color:var(--accent-error);min-height:18px;margin-bottom:6px">${esc(message)}</div>
        <button class="btn primary" type="submit">Sign in</button></form></div>`;
    document.getElementById('loginForm').addEventListener('submit', async e => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        btn.disabled = true; btn.textContent = 'Signing in…';
        try { await signIn(document.getElementById('lu').value.trim(), document.getElementById('lp').value); location.reload(); }
        catch (err) { document.getElementById('le').textContent = err.message; btn.disabled = false; btn.textContent = 'Sign in'; }
    });
    setTimeout(() => document.getElementById('lu').focus(), 30);
}

// ---------- start ----------
async function start() {
    let theme = 'dark';
    try { theme = localStorage.getItem('jd_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (_) {}
    document.documentElement.dataset.theme = theme;
    try { state.copilotOpen = localStorage.getItem('jd_copilot') !== '0'; } catch (_) {}
    if (!getToken()) return showLogin();
    try {
        const s = await (await fetch('/api/auth-status', { headers: authHeaders() })).json();
        if (!s.authenticated) { localStorage.removeItem('jd_token'); return showLogin(); }
        state.user = s.username || '';
    } catch (_) { return showLogin('Cannot reach the server.'); }
    renderShell();
    renderActivity();
    loadCases();
    await route();
    refreshStatus();
}
start();
