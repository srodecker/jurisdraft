// ============================================================
// Cases — searchable, filterable, sortable list
// ============================================================
import { api, state, esc, fmtDate, fmtMoney, statusChip, icon, action, ago } from '../core.js';
import { loadCases } from '../main.js';

const ui = { q: '', stage: 'all', sort: 'deadline', dir: 1, showClosed: false };

export async function renderCases(view) {
    view.innerHTML = `<div class="empty">Loading…</div>`;
    await loadCases();
    view.innerHTML = `
        <div class="pagehead"><div><h1 class="h1">Cases</h1><p class="sub" id="casesCount"></p></div>
            <div class="right">
                <input class="input" id="caseFilter" style="width:260px" placeholder="Search name, case #, court…" value="${esc(ui.q)}">
                <button class="btn primary" data-act="new-case">${icon('plus')}New case</button>
            </div></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap" id="stageFilter"></div>
        <div class="card flush" id="casesTable"></div>`;
    document.getElementById('caseFilter').addEventListener('input', e => { ui.q = e.target.value; draw(); });
    draw();
}

function rows() {
    const q = ui.q.toLowerCase();
    let list = state.cases.filter(c => ui.showClosed || c.status !== 'closed');
    if (ui.stage !== 'all') list = list.filter(c => c.stage.key === ui.stage);
    if (q) list = list.filter(c => `${c.debtorName} ${c.caseNumber} ${c.courtName} ${c.courtCounty} ${c.stage.label} ${c.creditorName}`.toLowerCase().includes(q));
    const key = {
        name: c => (c.debtorName || '').toLowerCase(),
        deadline: c => c.nextDeadline ? c.nextDeadline.date : '9999',
        demand: c => parseFloat(c.demandAmount) || 0,
        updated: c => c.updatedAt || '',
        stage: c => c.stage.step
    }[ui.sort];
    return list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * ui.dir);
}

function draw() {
    const list = rows();
    const counts = {};
    state.cases.forEach(c => { counts[c.stage.key] = (counts[c.stage.key] || 0) + 1; });
    const stages = [...new Map(state.cases.map(c => [c.stage.key, c.stage])).values()].sort((a, b) => a.step - b.step);
    document.getElementById('casesCount').textContent = `${list.length} of ${state.cases.length} case${state.cases.length === 1 ? '' : 's'}`;
    document.getElementById('stageFilter').innerHTML = `<div class="seg">${[{ key: 'all', label: 'All stages' }, ...stages].map(s => `<button class="${ui.stage === s.key ? 'on' : ''}" data-act="cases-stage" data-stage="${s.key}">${esc(s.label)}${s.key !== 'all' ? ` · ${counts[s.key]}` : ''}</button>`).join('')}</div>
        <button class="btn ghost sm" style="margin-left:auto" data-act="cases-closed">${ui.showClosed ? 'Hide closed cases' : 'Show closed cases'}</button>`;
    const th = (k, l, cls = '') => `<th class="sort ${cls}" data-act="cases-sort" data-key="${k}">${l}${ui.sort === k ? (ui.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    document.getElementById('casesTable').innerHTML = list.length ? `<table class="tbl"><thead><tr>
            ${th('name', 'Debtor')}<th>Case #</th><th>Court</th>${th('stage', 'Stage')}${th('deadline', 'Next deadline')}${th('demand', 'Demand', 'num')}<th>Documents</th>${th('updated', 'Updated')}
        </tr></thead><tbody>${list.map(c => `<tr data-act="go" data-href="#/case/${c.id}/overview">
            <td><b>${esc(c.debtorName || 'Unnamed')}</b>${c.status === 'closed' ? ' <span class="chip">Closed</span>' : ''}</td>
            <td>${esc(c.caseNumber || '—')}</td>
            <td>${esc(c.courtCounty ? c.courtCounty + ' County' : (c.courtName || '—'))}</td>
            <td><span class="chip blue">${esc(c.stage.label)}</span></td>
            <td>${c.nextDeadline ? `${statusChip(c.nextDeadline.status)}<div class="small" style="margin-top:3px">${esc(c.nextDeadline.title)} · ${fmtDate(c.nextDeadline.date, { short: true })}</div>` : '<span class="muted">—</span>'}</td>
            <td class="num">${c.demandAmount ? esc(fmtMoney(c.demandAmount)) : '—'}</td>
            <td>${c.docCount}${c.unreadDocCount ? ` <span class="chip amber">${c.unreadDocCount} reading</span>` : ''}${c.failedDocCount ? ` <span class="chip err">${c.failedDocCount} failed</span>` : ''}${c.conflictCount ? ` <span class="chip amber">${c.conflictCount} to review</span>` : ''}</td>
            <td class="muted small">${esc(ago(c.updatedAt))}</td>
        </tr>`).join('')}</tbody></table>`
        : `<div class="empty"><div class="big">${state.cases.length ? 'No matching cases' : 'No cases yet'}</div>${state.cases.length ? 'Try a different search or stage.' : 'Click <b>New case</b>, then drop the case documents in.'}</div>`;
}

action('cases-stage', d => { ui.stage = d.stage; draw(); });
action('cases-sort', d => { if (ui.sort === d.key) ui.dir = -ui.dir; else { ui.sort = d.key; ui.dir = d.key === 'updated' || d.key === 'demand' ? -1 : 1; } draw(); });
action('cases-closed', () => { ui.showClosed = !ui.showClosed; draw(); });
