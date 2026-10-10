// ============================================================
// Calendar — every computed deadline, hearing and reminder across cases
// ============================================================
import { api, esc, icon, toast, modal, action, MONTHS, parseISO, fmtDate, relDays, statusChip } from '../core.js';

const cal = { mode: 'month', cursor: null };

function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

export async function renderCalendar(view) {
    if (!cal.cursor) { const t = new Date(); cal.cursor = new Date(t.getFullYear(), t.getMonth(), 1); }
    const first = new Date(cal.cursor.getFullYear(), cal.cursor.getMonth(), 1);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
    const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
    const from = cal.mode === 'month' ? iso(gridStart) : iso(new Date(Date.now() - 30 * 86400000));
    const to = cal.mode === 'month' ? iso(gridEnd) : iso(new Date(Date.now() + 120 * 86400000));
    view.innerHTML = `<div class="empty">Loading…</div>`;
    let d;
    try { d = await api(`/api/calendar?from=${from}&to=${to}`); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const head = `<div class="pagehead"><div><h1 class="h1">Calendar</h1><p class="sub">Deadlines are computed from each case's dates (CRC 3.110, CCP 412.20/415.20, CCP 683.020) plus hearings and your reminders.</p></div>
        <div class="right">
            <div class="seg"><button class="${cal.mode === 'month' ? 'on' : ''}" data-act="cal-mode" data-mode="month">Month</button><button class="${cal.mode === 'agenda' ? 'on' : ''}" data-act="cal-mode" data-mode="agenda">Agenda</button></div>
            <button class="btn secondary" data-act="cal-subscribe">${icon('calendar')}Add to Outlook / Google</button>
        </div></div>`;
    if (cal.mode === 'agenda') {
        const upcoming = d.items.filter(x => x.status !== 'done');
        let last = '';
        view.innerHTML = head + `<div class="card">${upcoming.length ? upcoming.map(x => {
            const month = x.date.slice(0, 7);
            const h = month !== last ? `<div class="group-h">${MONTHS[+month.slice(5) - 1]} ${month.slice(0, 4)}</div>` : '';
            last = month;
            return h + `<div class="row link" data-act="go" data-href="#/case/${x.caseId}/overview"><div class="datebox"><span>${MONTHS[parseISO(x.date).getMonth()]}</span><b>${parseISO(x.date).getDate()}</b></div>
                <div class="grow"><div class="t">${esc(x.title)}</div><div class="d">${esc(x.caseLabel)} · ${relDays(x.daysAway)} · ${esc(x.rule || '')}</div></div>${x.kind === 'info' ? '<span class="chip">Info</span>' : statusChip(x.status)}
                ${x.form ? `<button class="btn secondary sm" data-act="prepare-form" data-stop data-case="${x.caseId}" data-form="${esc(x.form)}">Prepare</button>` : ''}</div>`;
        }).join('') : '<div class="empty">Nothing scheduled.</div>'}</div>`;
        return;
    }
    const byDay = {};
    d.items.forEach(x => { (byDay[x.date] = byDay[x.date] || []).push(x); });
    const days = [];
    for (let i = 0; i < 42; i++) { const x = new Date(gridStart); x.setDate(gridStart.getDate() + i); days.push(x); }
    const todayIso = d.today;
    view.innerHTML = head + `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <button class="btn secondary sm icon" data-act="cal-move" data-n="-1" title="Previous month">‹</button>
            <button class="btn secondary sm" data-act="cal-today">Today</button>
            <button class="btn secondary sm icon" data-act="cal-move" data-n="1" title="Next month">›</button>
            <b style="font-size:15px;margin-left:6px">${MONTHS[first.getMonth()]} ${first.getFullYear()}</b>
            <span class="muted small" style="margin-left:auto"><span class="chip err">overdue</span> <span class="chip amber">due soon</span> <span class="chip blue">upcoming</span> <span class="chip" style="color:#818cf8">hearing</span></span>
        </div>
        <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<div class="dow">${w}</div>`).join('')}
            ${days.map(day => {
                const k = iso(day);
                const evs = byDay[k] || [];
                return `<div class="day ${day.getMonth() !== first.getMonth() ? 'out' : ''} ${k === todayIso ? 'today' : ''}"><span class="dn">${day.getDate()}</span>
                    ${evs.slice(0, 4).map(x => `<a class="ev ${x.kind === 'hearing' ? 'hearing' : x.status}" data-act="go" data-href="#/case/${x.caseId}/overview" title="${esc(x.title)} — ${esc(x.caseLabel)}">${esc(x.title)} · ${esc(x.caseLabel.split(' · ')[0])}</a>`).join('')}
                    ${evs.length > 4 ? `<a class="ev" data-act="cal-day" data-day="${k}">+${evs.length - 4} more</a>` : ''}</div>`;
            }).join('')}
        </div>`;
    cal.items = d.items;
}

action('cal-mode', d => { cal.mode = d.mode; renderCalendar(document.getElementById('view')); });
action('cal-move', d => { cal.cursor = new Date(cal.cursor.getFullYear(), cal.cursor.getMonth() + Number(d.n), 1); renderCalendar(document.getElementById('view')); });
action('cal-today', () => { const t = new Date(); cal.cursor = new Date(t.getFullYear(), t.getMonth(), 1); renderCalendar(document.getElementById('view')); });
action('cal-day', d => {
    const list = (cal.items || []).filter(x => x.date === d.day);
    modal(fmtDate(d.day), list.map(x => `<div class="row link" data-act="go" data-href="#/case/${x.caseId}/overview"><div class="grow"><div class="t">${esc(x.title)}</div><div class="d">${esc(x.caseLabel)} · ${esc(x.rule || '')}</div></div>${statusChip(x.status)}</div>`).join(''));
});
action('cal-subscribe', async () => {
    try {
        const { url } = await api('/api/calendar/feed');
        modal('Subscribe to your deadlines', `<p style="margin-top:0">Add this link as a calendar subscription. Deadlines, hearings and reminders update automatically (Outlook and Google refresh every few hours).</p>
            <input class="input" id="icsUrl" readonly value="${esc(url)}" onclick="this.select()">
            <ul class="keyfacts" style="margin-top:12px"><li><b>Outlook:</b> Add calendar → Subscribe from web → paste the link.</li><li><b>Google Calendar:</b> Other calendars → + → From URL → paste the link.</li></ul>
            <p class="muted small">Anyone with this link can see your deadline list. Use “New link” to revoke it.</p>`,
            `<button class="btn ghost" data-act="cal-reset">New link</button><button class="btn primary" data-act="cal-copy">Copy link</button>`);
    } catch (e) { toast(e.message, 'err'); }
});
action('cal-copy', async () => {
    const v = document.getElementById('icsUrl').value;
    try { await navigator.clipboard.writeText(v); toast('Link copied'); } catch (_) { document.getElementById('icsUrl').select(); }
});
action('cal-reset', async () => {
    if (!confirm('Create a new link? The old one stops working.')) return;
    try { const { url } = await api('/api/calendar/feed?reset=1'); document.getElementById('icsUrl').value = url; toast('New link created'); } catch (e) { toast(e.message, 'err'); }
});
