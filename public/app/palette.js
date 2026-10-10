// ============================================================
// Command palette (Ctrl/⌘+K): jump to a case or page, ask the assistant, prepare a form
// ============================================================
import { state, esc, icon, caseLabel, modal, closeModal, action, runAction } from './core.js';

let items = [];
let sel = 0;

const PAGES = [
    ['Today', '#/today', 'today'], ['Cases', '#/cases', 'cases'], ['Calendar', '#/calendar', 'calendar'],
    ['Client report', '#/reports', 'report'], ['Assistant', '#/assistant', 'chat'], ['Forms', '#/forms', 'file'], ['Settings', '#/settings', 'settings']
];

export function openPalette() {
    modal('Search', `<input class="pal-in" id="palIn" placeholder="Search cases, pages, or type a question for the assistant…" autocomplete="off"><div class="pal-list" id="palList"></div>`);
    const box = document.querySelector('.modal');
    box.querySelector('.modal-h').classList.add('hidden');
    box.querySelector('.modal-b').style.padding = '0';
    const input = document.getElementById('palIn');
    input.addEventListener('input', () => { sel = 0; draw(input.value); });
    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); e.preventDefault(); paint(); }
        else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); e.preventDefault(); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
    });
    draw('');
    input.focus();
}

function draw(q) {
    const t = q.trim().toLowerCase();
    const cases = state.cases.filter(c => !t || caseLabel(c).toLowerCase().includes(t) || (c.creditorName || '').toLowerCase().includes(t)).slice(0, 8)
        .map(c => ({ sec: 'Cases', label: caseLabel(c), hint: c.stage ? c.stage.label : '', icon: 'cases', href: `#/case/${c.id}/overview` }));
    const pages = PAGES.filter(p => !t || p[0].toLowerCase().includes(t)).map(([l, h, i]) => ({ sec: 'Go to', label: l, icon: i, href: h }));
    const ask = t ? [{ sec: 'Assistant', label: `Ask: “${q.trim()}”`, icon: 'sparkle', ask: q.trim() }] : [];
    const caseActs = state.caseId && state.caseView ? [
        { sec: 'This case', label: 'Upload documents', icon: 'upload', act: 'pick-files' },
        { sec: 'This case', label: 'Edit facts', icon: 'edit', act: 'edit-facts' },
        { sec: 'This case', label: 'Add reminder', icon: 'clock', act: 'add-reminder' }
    ].filter(a => !t || a.label.toLowerCase().includes(t)) : [];
    items = [...(cases.length && t ? cases : []), ...caseActs, ...ask, ...pages, ...(!t ? cases : [])];
    paint();
}

function paint() {
    let last = '';
    document.getElementById('palList').innerHTML = items.length ? items.map((it, i) => {
        const head = it.sec !== last ? `<div class="pal-sec">${esc(it.sec)}</div>` : '';
        last = it.sec;
        return `${head}<div class="pal-i ${i === sel ? 'on' : ''}" data-act="pal-run" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<span class="k">${esc(it.hint)}</span>` : ''}</div>`;
    }).join('') : '<div class="empty">No matches</div>';
    const on = document.querySelector('.pal-i.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
}

function run(it) {
    if (!it) return;
    closeModal();
    if (it.href) location.hash = it.href;
    else if (it.ask) { state.pendingAsk = it.ask; location.hash = '#/assistant'; }
    else if (it.act) runAction(it.act);
}

action('pal-run', d => run(items[+d.i]));
action('open-palette', openPalette);
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.user) openPalette(); }
});
