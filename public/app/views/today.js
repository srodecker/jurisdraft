// ============================================================
// Today — what needs doing across every case
// ============================================================
import { api, state, esc, fmtDate, fmtMoney, relDays, dateBox, statusChip, icon, caseLabel, action } from '../core.js';
import { setCases } from '../main.js';

export async function renderToday(view) {
    view.innerHTML = `<div class="empty">Loading…</div>`;
    let d;
    try { d = await api('/api/dashboard/today'); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    setCases(d.cases);
    const overdue = d.attention.filter(a => a.status === 'overdue');
    const week = d.attention.filter(a => a.status !== 'overdue' && a.daysAway <= 7);
    const later = d.attention.filter(a => a.status !== 'overdue' && a.daysAway > 7);
    const active = d.cases.filter(c => c.status !== 'closed');
    const review = d.cases.filter(c => c.conflictCount || c.failedDocCount);
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = state.user ? state.user.charAt(0).toUpperCase() + state.user.slice(1) : '';
    const maxStage = Math.max(1, ...d.stages.map(s => d.pipeline[s.key] || 0));

    const item = a => `
        <div class="row link" data-act="go" data-href="#/case/${a.caseId}/overview">
            ${dateBox(a.date)}
            <div class="grow"><div class="t">${esc(a.title)}</div><div class="d">${esc(a.caseLabel)} · ${relDays(a.daysAway)} · ${esc(a.rule)}</div></div>
            ${statusChip(a.status)}
            ${a.form ? `<button class="btn secondary sm" data-act="prepare-form" data-stop data-case="${a.caseId}" data-form="${esc(a.form)}">Prepare</button>` : ''}
        </div>`;

    view.innerHTML = `
        <div class="pagehead"><div><h1 class="h1">${hello}${name ? ', ' + esc(name) : ''}</h1><p class="sub">${fmtDate(d.today)} · ${active.length} active case${active.length === 1 ? '' : 's'}</p></div>
            <div class="right"><button class="btn primary" data-act="new-case">${icon('plus')}New case</button></div></div>
        <div class="tiles">
            <a class="tile red" href="#/today"><div class="n">${overdue.length}</div><div class="l">Overdue</div></a>
            <a class="tile amber" href="#/calendar"><div class="n">${week.length}</div><div class="l">Due in the next 7 days</div></a>
            <a class="tile blue" href="#/calendar"><div class="n">${d.hearings.length}</div><div class="l">Hearings in 60 days</div></a>
            <a class="tile" href="#/cases"><div class="n">${active.length}</div><div class="l">Active cases</div></a>
            <a class="tile ${review.length ? 'amber' : ''}" href="#/cases"><div class="n">${review.length}</div><div class="l">Cases needing review</div></a>
        </div>
        <div class="card" style="display:flex;gap:10px;align-items:center;padding:8px 10px 8px 14px">
            ${icon('sparkle')}
            <input class="input" id="quickAsk" style="border:0;background:none;box-shadow:none" placeholder="Ask about any case, or say what to do — “prepare the request for default for Acevedo”">
            <button class="btn primary" data-act="quick-ask">Ask</button>
        </div>
        <div class="cols">
            <div>
                <div class="card"><div class="card-h">${icon('clock')} Agenda <span class="r muted">deadlines due within 14 days</span></div>
                    ${d.attention.length ? `
                        ${overdue.length ? `<div class="group-h red">Overdue</div>${overdue.map(item).join('')}` : ''}
                        ${week.length ? `<div class="group-h">This week</div>${week.map(item).join('')}` : ''}
                        ${later.length ? `<div class="group-h">Next week</div>${later.map(item).join('')}` : ''}`
                    : `<div class="empty"><div class="big">You're clear</div>Nothing overdue or due in the next two weeks.</div>`}
                </div>
                <div class="card flush"><div class="card-h" style="padding:14px 16px 0">${icon('cases')} Cases <a class="r" href="#/cases">All cases →</a></div>
                    ${miniCases(d.cases.slice(0, 8))}
                </div>
            </div>
            <div>
                ${review.length ? `<div class="card warn"><div class="card-h">${icon('warn')} Needs your review</div>
                    ${review.map(c => `<div class="row link" data-act="go" data-href="#/case/${c.id}/${c.conflictCount ? 'overview' : 'documents'}"><div class="grow"><div class="t">${esc(caseLabel(c))}</div><div class="d">${[c.conflictCount ? `${c.conflictCount} fact${c.conflictCount === 1 ? '' : 's'} where documents disagree` : '', c.failedDocCount ? `${c.failedDocCount} document${c.failedDocCount === 1 ? '' : 's'} couldn't be read` : ''].filter(Boolean).join(' · ')}</div></div>${icon('arrow')}</div>`).join('')}
                </div>` : ''}
                <div class="card"><div class="card-h">${icon('gavel')} Upcoming hearings</div>
                    ${d.hearings.length ? d.hearings.map(h => `<div class="row link" data-act="go" data-href="#/case/${h.caseId}/overview">${dateBox(h.date)}<div class="grow"><div class="t">${esc(h.type || 'Hearing')}</div><div class="d">${esc(h.caseLabel)}${h.time ? ' · ' + esc(h.time) : ''}${h.department ? ' · ' + esc(h.department) : ''}</div></div><span class="chip">${relDays(h.daysAway)}</span></div>`).join('') : '<div class="empty">No hearings in the next 60 days.</div>'}
                </div>
                <div class="card"><div class="card-h">${icon('report')} Pipeline</div>
                    ${d.stages.map(s => `<div style="display:flex;align-items:center;gap:10px;margin:7px 0"><span style="width:150px;font-size:12px;color:var(--text-secondary)">${esc(s.label)}</span><div class="bar" style="flex:1"><i style="width:${Math.round(100 * (d.pipeline[s.key] || 0) / maxStage)}%"></i></div><b style="width:20px;text-align:right">${d.pipeline[s.key] || 0}</b></div>`).join('')}
                </div>
                <div class="card"><div class="card-h">${icon('file')} Recent documents</div>
                    ${d.recentDocs.length ? d.recentDocs.slice(0, 8).map(x => `<div class="row link" data-act="go" data-href="#/case/${x.caseId}/documents/${x.id}"><div class="grow"><div class="t" style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.fileName)}</div><div class="d">${esc(x.caseLabel)}${x.documentType ? ' · ' + esc(x.documentType) : ''}</div></div>${x.analysisStatus === 'done' ? '<span class="chip green">Read</span>' : x.analysisStatus === 'error' ? '<span class="chip err">Failed</span>' : '<span class="chip amber">Reading</span>'}</div>`).join('') : '<div class="empty">No documents yet.</div>'}
                </div>
            </div>
        </div>`;
    const qa = document.getElementById('quickAsk');
    qa.addEventListener('keydown', e => { if (e.key === 'Enter') quickAsk(); });
}

function miniCases(list) {
    if (!list.length) return `<div class="empty"><div class="big">No cases yet</div>Click <b>New case</b>, then drop the case documents in.</div>`;
    return `<table class="tbl"><tbody>${list.map(c => `<tr data-act="go" data-href="#/case/${c.id}/overview">
        <td><b>${esc(c.debtorName || 'Unnamed')}</b><div class="muted small">${esc(c.caseNumber || 'not filed')}</div></td>
        <td><span class="chip blue">${esc(c.stage.label)}</span></td>
        <td>${c.nextDeadline ? `${statusChip(c.nextDeadline.status)} <span class="small">${esc(c.nextDeadline.title)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${c.demandAmount ? esc(fmtMoney(c.demandAmount)) : ''}</td></tr>`).join('')}</tbody></table>`;
}

function quickAsk() {
    const q = document.getElementById('quickAsk').value.trim();
    if (!q) return;
    state.pendingAsk = q;
    location.hash = '#/assistant';
}
action('quick-ask', quickAsk);
