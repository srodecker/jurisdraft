// ============================================================
// Case workspace: header, Overview, Timeline, Notes (+ Documents, Forms in their modules)
// ============================================================
import { api, state, esc, fmtDate, fmtMoney, relDays, dateBox, statusChip, icon, toast, modal, closeModal, action, on } from '../core.js';
import { renderDocuments } from './documents.js';
import { renderCaseForms } from './forms.js';
import { drive, caseProgress } from '../queue.js';
import { loadCases, setCrumbs, renderCopilot } from '../main.js';

const TABS = [['overview', 'Overview'], ['documents', 'Documents'], ['timeline', 'Timeline'], ['forms', 'Forms'], ['notes', 'Notes']];

export async function loadCaseView(id) {
    const v = await api(`/api/cases/${id}`);
    if (state.caseId === id) state.caseView = v;
    return v;
}

export async function renderCase(view, id, tab, sub) {
    if (state.caseId !== id || !state.caseView) {
        state.caseId = id;
        state.caseView = null;
        state.docSel = null;
        view.innerHTML = `<div class="empty">Loading case…</div>`;
        try { await loadCaseView(id); } catch (e) { view.innerHTML = `<div class="empty"><div class="big">Case not found</div><a href="#/cases">Back to cases</a></div>`; return; }
        const pending = state.caseView.documents.some(d => d.analysisStatus === 'queued' || d.analysisStatus === 'reading');
        if (pending) drive(id);
    }
    state.tab = TABS.some(t => t[0] === tab) ? tab : 'overview';
    if (state.tab === 'documents' && sub) state.docSel = sub;
    view.innerHTML = `<div id="caseHead"></div><div id="caseBanners"></div><div id="tabBody"></div>`;
    renderHead();
    renderBanners();
    renderTab();
    renderCopilot();
}

export async function reloadCase(id = state.caseId) {
    if (!id || state.caseId !== id) return;
    try { await loadCaseView(id); } catch (_) { return; }
    if (!location.hash.startsWith(`#/case/${id}`)) return;
    renderHead();
    renderBanners();
    renderTab({ soft: true });
}

function renderHead() {
    const el = document.getElementById('caseHead');
    if (!el || !state.caseView) return;
    const v = state.caseView, m = v.matter;
    setCrumbs([['Cases', '#/cases'], [m.debtorName || 'Case']]);
    const court = [m.courtBranch || m.courtName, m.courtCounty ? m.courtCounty + ' County' : ''].filter(Boolean).join(' · ');
    const failed = v.documents.filter(d => d.analysisStatus === 'error').length;
    const counts = { documents: v.documents.length, forms: (m.generatedForms || []).length, timeline: (m.events || []).filter(e => e.title && e.type !== 'note').length, notes: (m.events || []).filter(e => e.type === 'note' && e.addedBy !== 'documents').length };
    const money = [['Demand', m.demandAmount], ['Payoff balance', m.payoffBalance], ['Judgment', m.judgmentAmount], ['Costs', m.costs]].filter(x => x[1]);
    el.innerHTML = `
        <div class="casehead">
            <div style="min-width:0">
                <h1 class="h1">${esc(m.debtorName || 'Unnamed case')} ${m.status === 'closed' ? '<span class="chip">Closed</span>' : ''}</h1>
                <div class="meta">
                    <span>Case # <b>${esc(m.caseNumber || 'not filed')}</b></span>
                    ${court ? `<span>${esc(court)}</span>` : ''}
                    ${m.creditorName ? `<span>${esc(m.creditorName)}</span>` : ''}
                    ${m.accountNumber ? `<span>Acct ${esc(m.accountNumber)}</span>` : ''}
                </div>
            </div>
            <div class="acts">
                <button class="btn secondary" data-act="pick-files">${icon('upload')}Upload</button>
                <button class="btn secondary" data-act="edit-facts">${icon('edit')}Edit facts</button>
                <button class="btn secondary icon" data-act="case-menu" title="More">${icon('dots')}</button>
                <button class="btn ${state.copilotOpen ? 'secondary' : 'primary'}" data-act="toggle-copilot">${icon('sparkle')}${state.copilotOpen ? 'Hide AI' : 'Ask AI'}</button>
            </div>
        </div>
        <div class="stepper">${v.stages.map((s, i) => `<div class="${v.stage.key === 'closed' || i < v.stage.step ? 'past' : i === v.stage.step ? 'cur' : ''}" title="${esc(s.label)}">${esc(s.label)}</div>`).join('')}</div>
        ${money.length ? `<div class="money">${money.map(([l, val]) => `<div class="m"><span>${l}</span><b>${esc(fmtMoney(val))}</b></div>`).join('')}</div>` : ''}
        <div class="tabs">${TABS.map(([k, l]) => `<a class="${state.tab === k ? 'on' : ''}" href="#/case/${m.id}/${k}">${l}${counts[k] ? `<span class="badge ${k === 'documents' && failed ? 'red' : ''}">${counts[k]}</span>` : ''}</a>`).join('')}</div>`;
}

function renderBanners() {
    const el = document.getElementById('caseBanners');
    if (!el || !state.caseView) return;
    const v = state.caseView;
    const p = caseProgress(v.matter.id);
    const pending = v.documents.filter(d => d.analysisStatus === 'queued' || d.analysisStatus === 'reading').length;
    let html = '';
    if (state.schemaProblem) {
        html += `<div class="banner err">${icon('warn')}<div style="flex:1"><b>Documents can't be read yet — the database needs a one-time update.</b> Run this in Supabase → SQL Editor, then reload:
            <pre>${esc(state.schemaProblem.sql || '')}</pre><span class="small">${esc(String(state.schemaProblem.detail || '').slice(0, 200))}</span></div></div>`;
    }
    if (pending) {
        const total = v.documents.length, done = total - pending;
        html += `<div class="banner info"><div class="spin"></div><div style="flex:1">Reading documents — ${done} of ${total} done. Facts fill in as each one is read; you can leave this page.
            <div class="bar" style="margin-top:6px"><i style="width:${Math.round(100 * done / Math.max(total, 1))}%"></i></div></div></div>`;
    } else if (p && p.upgrading) {
        html += `<div class="banner info"><div class="spin"></div><div>Re-checking ${p.upgrading} document${p.upgrading === 1 ? '' : 's'} for more detail (amounts, quotes)…</div></div>`;
    }
    el.innerHTML = html;
}

function renderTab(opts = {}) {
    const body = document.getElementById('tabBody');
    if (!body || !state.caseView) return;
    const fn = { overview: renderOverview, documents: renderDocuments, timeline: renderTimeline, forms: renderCaseForms, notes: renderNotes }[state.tab] || renderOverview;
    fn(body, opts);
}

// ---------- Overview ----------
function src(field) {
    const m = state.caseView.matter;
    if (m.factOverrides && m.factOverrides[field] !== undefined) return `<span class="src" title="You set this value">${icon('edit')}edited</span>`;
    let s = m.fieldSources && m.fieldSources[field];
    if (!s) return '';
    if (typeof s === 'string') s = { fileName: s };
    const tip = `From ${s.fileName}${s.quote ? ': “' + s.quote + '”' : ''}${s.count > 1 ? ` — also in ${s.count - 1} more document${s.count > 2 ? 's' : ''}` : ''}`;
    return `<button class="src" title="${esc(tip)}" data-act="open-source" data-doc="${esc(s.docId || '')}" data-quote="${esc(s.quote || '')}">${icon('file')}${esc(s.fileName)}</button>`;
}
function fact(label, value, field) {
    const m = state.caseView.matter;
    const conflict = (m.factConflicts || []).some(c => c.field === field);
    return `<dt>${label}</dt><dd>${value ? esc(value) : '<span class="blank">—</span>'}${conflict ? ' <span class="chip amber">check</span>' : ''}${value && field ? src(field) : ''}</dd>`;
}

function renderOverview(body) {
    const v = state.caseView, m = v.matter, d = m.dates || {};
    const addr = [m.debtorAddress, m.debtorCity, [m.debtorState, m.debtorZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const failed = v.documents.filter(x => x.analysisStatus === 'error');
    const reading = v.documents.some(x => x.analysisStatus === 'queued' || x.analysisStatus === 'reading');
    const nextForm = v.deadlines.find(x => x.form && x.status !== 'done');
    const service = d.served ? `${fmtDate(d.served)}${m.serviceType ? ' · ' + m.serviceType : ''}` : '';
    const loan = [['Loan type', m.loanType, 'loanType'], ['Account', m.accountNumber, 'accountNumber'], ['Contract date', m.contractDate && fmtDate(m.contractDate), 'contractDate'], ['Principal', m.principal && fmtMoney(m.principal), 'principal'], ['Interest', m.interestAmount && fmtMoney(m.interestAmount), 'interestAmount'], ['Interest rate', m.interestRate, 'interestRate'], ['Charge-off', m.chargeOffDate && fmtDate(m.chargeOffDate), 'chargeOffDate'], ['Last payment', m.lastPaymentAmount && `${fmtMoney(m.lastPaymentAmount)}${m.lastPaymentDate ? ' on ' + fmtDate(m.lastPaymentDate) : ''}`, 'lastPaymentAmount'], ['Payoff balance', m.payoffBalance && fmtMoney(m.payoffBalance), 'payoffBalance'], ['Costs', m.costs && fmtMoney(m.costs), 'costs'], ['Attorney fees', m.attorneyFees && fmtMoney(m.attorneyFees), 'attorneyFees']].filter(r => r[1]);
    const recent = [...(m.events || [])].filter(e => e.title).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);

    if (!v.documents.length) {
        body.innerHTML = `<div class="card"><div class="drop" data-act="pick-files" style="padding:44px 20px;margin:0">
            <div style="font-size:16px;font-weight:700;margin-bottom:4px">Drop this case's documents here</div>
            <div>Complaint, summons, proofs of service, court notices, account statements, emails (.msg / .eml). Each is read once; the case fills itself in.</div></div></div>`;
        return;
    }
    body.innerHTML = `
        ${failed.length ? `<div class="banner">${icon('warn')}<div style="flex:1">${failed.length} document${failed.length === 1 ? '' : 's'} couldn't be read — the case is built from the others. <a href="#/case/${m.id}/documents/${failed[0].id}">See why and retry</a></div></div>` : ''}
        ${m.nextStep || nextForm ? `<div class="card accent"><div class="nextstep">${icon('arrow')}<div style="flex:1"><div class="k">Next step</div><div class="v">${esc(m.nextStep || `${nextForm.title} — ${relDays(nextForm.daysAway)}`)}</div></div>
            ${nextForm ? `<button class="btn primary" data-act="prepare-form" data-case="${m.id}" data-form="${esc(nextForm.form)}">Prepare ${esc(nextForm.form.replace(/\.(pdf|docx)$/, ''))}</button>` : ''}</div></div>` : ''}
        ${conflictsCard(m)}
        <div class="cols">
            <div>
                <div class="card"><div class="card-h">${icon('sparkle')} Case summary ${m.summaryUpdatedAt ? `<span class="r muted">updated ${esc(fmtDate(String(m.summaryUpdatedAt).slice(0, 10)))}</span>` : ''}</div>
                    ${m.summary ? `<p class="summary">${esc(m.summary)}</p>` : `<p class="muted" style="margin:0">${reading ? 'The summary is written once the documents are read. Facts below fill in as each one is done.' : 'No summary yet — use ⋯ → Re-analyze.'}</p>`}
                    ${(m.keyFacts || []).length ? `<ul class="keyfacts">${m.keyFacts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
                    ${m.statusText ? `<div style="margin-top:10px"><span class="muted">Status:</span> ${esc(m.statusText)}</div>` : ''}
                    ${m.synthesisError ? `<div class="small muted" style="margin-top:8px">The last summary update failed (${esc(m.synthesisError.slice(0, 120))}); facts are current.</div>` : ''}
                </div>
                <div class="card"><div class="card-h">Parties &amp; court <button class="btn ghost sm r" data-act="edit-facts">Edit</button></div>
                    <dl class="facts">
                        ${fact('Defendant', m.debtorName, 'debtorName')}
                        ${fact('Address', addr, 'debtorAddress')}
                        ${fact('Plaintiff', m.creditorName, 'creditorName')}
                        ${fact('Case number', m.caseNumber, 'caseNumber')}
                        ${fact('Court', m.courtName, 'courtName')}
                        ${fact('Courthouse', [m.courtBranch, m.courtAddress].filter(Boolean).join(' — '), 'courtAddress')}
                        ${fact('Demand', m.demandAmount && fmtMoney(m.demandAmount), 'demandAmount')}
                        ${fact('Judgment', m.judgmentAmount && fmtMoney(m.judgmentAmount), 'judgmentAmount')}
                    </dl>
                </div>
                <div class="card"><div class="card-h">Service, default &amp; judgment <button class="btn ghost sm r" data-act="edit-facts">Edit</button></div>
                    <dl class="facts">
                        ${fact('Complaint filed', d.complaintFiled && fmtDate(d.complaintFiled), 'dates.complaintFiled')}
                        ${fact('Served', service, 'dates.served')}
                        ${fact('Served by', m.servedBy, 'servedBy')}
                        ${fact('Served at', m.serviceAddress, 'serviceAddress')}
                        ${fact('Response', m.defendantResponse || (d.answerReceived ? 'Answer filed ' + fmtDate(d.answerReceived) : ''), 'defendantResponse')}
                        ${fact('Default requested', d.defaultRequested && fmtDate(d.defaultRequested), 'dates.defaultRequested')}
                        ${fact('Default entered', d.defaultEntered && fmtDate(d.defaultEntered), 'dates.defaultEntered')}
                        ${fact('Judgment entered', d.judgmentEntered && fmtDate(d.judgmentEntered), 'dates.judgmentEntered')}
                        ${d.abstractRecorded ? fact('Abstract recorded', fmtDate(d.abstractRecorded), 'dates.abstractRecorded') : ''}
                        ${d.writIssued ? fact('Writ issued', fmtDate(d.writIssued), 'dates.writIssued') : ''}
                    </dl>
                </div>
                ${loan.length ? `<div class="card"><div class="card-h">Loan &amp; balance</div><dl class="facts">${loan.map(([l, val, f]) => fact(l, val, f)).join('')}</dl></div>` : ''}
            </div>
            <div>
                <div class="card"><div class="card-h">${icon('clock')} Deadlines &amp; calendar <button class="btn ghost sm r" data-act="add-reminder">+ Reminder</button></div>
                    ${v.deadlines.length ? v.deadlines.map(x => deadlineRow(m, x)).join('') : `<div class="empty">Deadlines appear once the documents show filing, service or hearing dates.</div>`}
                </div>
                <div class="card"><div class="card-h">${icon('file')} Prepared forms <a class="r" href="#/case/${m.id}/forms">Forms →</a></div>
                    ${(m.generatedForms || []).length ? m.generatedForms.slice(0, 4).map(f => `<div class="row link" data-act="show-form" data-case="${m.id}" data-form="${f.id}"><div class="grow"><div class="t">${esc(f.code)} — ${esc(f.title)}</div><div class="d">${esc(fmtDate(String(f.createdAt).slice(0, 10)))}${f.missing && f.missing.length ? ` · <span style="color:var(--amber)">${f.missing.length} blank</span>` : ''}</div></div>${icon('arrow')}</div>`).join('') : `<div class="empty">None yet. Use <b>Next step</b>, the Forms tab, or ask the AI.</div>`}
                </div>
                <div class="card"><div class="card-h">Recent activity <a class="r" href="#/case/${m.id}/timeline">Timeline →</a></div>
                    ${recent.length ? recent.map(e => `<div class="row"><div class="grow"><div class="t" style="font-weight:500">${esc(e.title)}</div><div class="d">${esc(fmtDate(String(e.date).slice(0, 10)))}${e.source ? ' · ' + esc(e.source) : e.addedBy && e.addedBy !== 'documents' ? ' · ' + esc(e.addedBy) : ''}</div></div></div>`).join('') : '<div class="empty">Nothing yet.</div>'}
                </div>
            </div>
        </div>`;
}

function conflictsCard(m) {
    const list = m.factConflicts || [];
    if (!list.length) return '';
    return `<div class="card warn"><div class="card-h">${icon('warn')} Documents disagree — choose the right value</div>
        ${list.map(c => `<div class="conflict"><b>${esc(c.label)}</b>
            ${c.options.map(o => `<div class="opt ${o.value === c.chosen ? 'on' : ''}"><div style="flex:1"><div><b>${esc(c.field.startsWith('dates.') ? fmtDate(o.value) : o.value)}</b>${o.value === c.chosen ? ' <span class="chip blue">in use</span>' : ''}</div>
                ${o.sources.map(x => `<div class="q">${esc(x.fileName)}${x.quote ? ` — “${esc(x.quote)}”` : ''}</div>`).join('')}</div>
                <button class="btn ${o.value === c.chosen ? 'secondary' : 'primary'} sm" data-act="resolve-conflict" data-field="${esc(c.field)}" data-value="${esc(o.value)}">${o.value === c.chosen ? 'Confirm' : 'Use this'}</button></div>`).join('')}
        </div>`).join('')}</div>`;
}

function deadlineRow(m, x) {
    const done = x.status === 'done';
    return `<div class="row">${dateBox(x.date)}<div class="grow"><div class="t" style="${done ? 'color:var(--text-tertiary);text-decoration:line-through' : ''}">${esc(x.title)}</div><div class="d">${esc(x.rule || '')}${!done ? ' · ' + relDays(x.daysAway) : ''}</div></div>
        ${x.form && !done ? `<button class="btn secondary sm" data-act="prepare-form" data-case="${m.id}" data-form="${esc(x.form)}">Prepare</button>` : ''}
        ${x.kind === 'custom' ? `<button class="btn ghost sm icon" title="${done ? 'Mark not done' : 'Mark done'}" data-act="toggle-reminder" data-id="${x.id}" data-done="${done ? '' : '1'}">${icon('check')}</button><button class="btn ghost sm icon" title="Delete reminder" data-act="delete-reminder" data-id="${x.id}">${icon('x')}</button>` : ''}
        ${x.kind === 'info' ? (done ? '' : '<span class="chip">Info</span>') : statusChip(x.status)}</div>`;
}

// ---------- Timeline ----------
const tlFilter = { kind: 'all' };
function renderTimeline(body) {
    const m = state.caseView.matter;
    const kinds = { all: () => true, court: e => ['filing', 'minute_order', 'court_order', 'hearing'].includes(e.type), service: e => e.type === 'service', mail: e => e.type === 'correspondence', mine: e => e.addedBy && e.addedBy !== 'documents' };
    const events = [...(m.events || [])].filter(e => e.title && kinds[tlFilter.kind](e)).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    body.innerHTML = `<div class="card">
        <div style="margin-bottom:14px" class="seg">${[['all', 'All'], ['court', 'Court'], ['service', 'Service'], ['mail', 'Correspondence'], ['mine', 'Added by you / AI']].map(([k, l]) => `<button class="${tlFilter.kind === k ? 'on' : ''}" data-act="tl-filter" data-kind="${k}">${l}</button>`).join('')}</div>
        ${events.length ? `<div class="tl">${events.map(e => `<div class="tl-i ${e.type === 'note' ? 'note' : e.addedBy === 'documents' ? 'doc' : ''}">
            <div class="w">${esc(fmtDate(String(e.date).slice(0, 10)))} · ${esc(String(e.type || 'note').replace(/_/g, ' '))}${e.addedBy && e.addedBy !== 'documents' ? ' · ' + esc(e.addedBy) : ''}</div>
            <div class="t">${esc(e.title)}</div>${e.description ? `<div class="x">${esc(e.description)}</div>` : ''}${e.source ? `<div class="x muted small">Source: ${esc(e.source)}</div>` : ''}</div>`).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}
    </div>`;
}
action('tl-filter', d => { tlFilter.kind = d.kind; renderTab(); });

// ---------- Notes ----------
function renderNotes(body) {
    const m = state.caseView.matter;
    const notes = [...(m.events || [])].filter(e => e.type === 'note' && e.addedBy !== 'documents').sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)));
    body.innerHTML = `<div class="cols">
        <div class="card"><div class="card-h">${icon('note')} Notes</div>
            <textarea class="input" id="noteText" rows="3" placeholder="Call log, instructions from the client, anything to remember… (Ctrl+Enter to save)"></textarea>
            <div style="display:flex;justify-content:flex-end;margin:8px 0 6px"><button class="btn primary sm" data-act="add-note">Add note</button></div>
            ${notes.length ? notes.map(n => `<div class="row" style="align-items:flex-start"><div class="grow"><div style="white-space:pre-wrap">${esc(n.description || n.title)}</div><div class="d">${esc(n.addedBy || '')} · ${esc(fmtDate(String(n.createdAt || n.date).slice(0, 10)))}</div></div><button class="btn ghost sm icon" title="Delete" data-act="delete-note" data-id="${n.id}">${icon('x')}</button></div>`).join('') : '<div class="empty">No notes yet.</div>'}
        </div>
        <div class="card"><div class="card-h">${icon('report')} Note for client status report</div>
            <p class="muted small" style="margin-top:0">Shown on the Kinecta status report for this case. Leave blank to use the AI status.</p>
            <textarea class="input" id="reportNote" rows="4">${esc(m.reportNote || '')}</textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn secondary sm" data-act="save-report-note">Save</button></div>
        </div>
    </div>`;
    document.getElementById('noteText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote(); });
}
async function addNote() {
    const t = document.getElementById('noteText').value.trim();
    if (!t) return;
    try {
        await api(`/api/matters/${state.caseId}/events`, { json: { type: 'note', title: t.split('\n')[0].slice(0, 120), description: t, addedBy: state.user || 'user', date: new Date().toISOString().slice(0, 10) } });
        await reloadCase();
    } catch (e) { toast(e.message, 'err'); }
}
action('add-note', addNote);
action('delete-note', async d => {
    if (!confirm('Delete this note?')) return;
    try { await api(`/api/matters/${state.caseId}/events/${d.id}`, { method: 'DELETE' }); await reloadCase(); } catch (e) { toast(e.message, 'err'); }
});
action('save-report-note', async () => {
    try { await saveFacts({ reportNote: document.getElementById('reportNote').value }); toast('Saved'); } catch (e) { toast(e.message, 'err'); }
});

// ---------- facts / conflicts / reminders ----------
export async function saveFacts(updates) {
    const r = await api(`/api/cases/${state.caseId}/facts`, { method: 'PATCH', json: { updates } });
    state.caseView = { matter: r.matter, summary: r.summary, stage: r.stage, stages: r.stages, deadlines: r.deadlines, documents: r.documents };
    renderHead(); renderBanners(); renderTab({ soft: true });
    loadCases();
    return r;
}

action('resolve-conflict', async d => {
    try { await saveFacts({ [d.field]: d.value }); toast('Saved — this value is kept from now on'); } catch (e) { toast(e.message, 'err'); }
});

const FACT_FIELDS = [
    ['Defendant'], ['debtorName', 'Defendant name'], ['debtorAddress', 'Street address'], ['debtorCity', 'City'], ['debtorState', 'State'], ['debtorZip', 'ZIP'],
    ['Case & court'], ['caseNumber', 'Case number'], ['creditorName', 'Plaintiff / creditor'], ['courtName', 'Court'], ['courtCounty', 'County'], ['courtBranch', 'Courthouse'], ['courtAddress', 'Courthouse address (street, city, CA zip)'],
    ['Amounts'], ['demandAmount', 'Demand amount'], ['judgmentAmount', 'Judgment amount'], ['principal', 'Principal'], ['interestAmount', 'Interest'], ['interestRate', 'Interest rate'], ['payoffBalance', 'Payoff balance'], ['costs', 'Costs'], ['attorneyFees', 'Attorney fees'],
    ['Loan'], ['loanType', 'Loan type'], ['accountNumber', 'Account #'], ['contractDate', 'Contract date', 'date'], ['chargeOffDate', 'Charge-off date', 'date'], ['lastPaymentDate', 'Last payment date', 'date'], ['lastPaymentAmount', 'Last payment amount'],
    ['Service & status'], ['serviceType', 'Service type (personal / substituted)'], ['servedBy', 'Served by'], ['serviceAddress', 'Service address'], ['defendantResponse', 'Defendant response'], ['statusText', 'Status / last action'], ['nextStep', 'Next step'],
    ['Dates'], ['dates.complaintFiled', 'Complaint filed', 'date'], ['dates.served', 'Served', 'date'], ['dates.answerReceived', 'Answer received', 'date'], ['dates.defaultRequested', 'Default requested', 'date'], ['dates.defaultEntered', 'Default entered', 'date'], ['dates.judgmentEntered', 'Judgment entered', 'date'], ['dates.abstractRecorded', 'Abstract recorded', 'date'], ['dates.writIssued', 'Writ issued', 'date'], ['dates.closed', 'Closed', 'date']
];
function getFact(m, key) { const v = key.startsWith('dates.') ? (m.dates || {})[key.slice(6)] : m[key]; return String(v || ''); }
action('edit-facts', () => {
    const m = state.caseView.matter;
    modal('Edit case facts', `<p class="muted" style="margin-top:0">Your values are kept when documents are re-read. Clear a field to go back to what the documents say.</p>
        <div class="fgrid">${FACT_FIELDS.map(([k, l, type]) => !l ? `<div class="sec">${k}</div>` : `<div><label class="lbl">${esc(l)}</label><input class="input" data-fact="${k}" type="${type || 'text'}" value="${esc(type === 'date' ? getFact(m, k).slice(0, 10) : getFact(m, k))}"></div>`).join('')}</div>`,
        `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="save-facts">Save</button>`, { wide: true });
});
action('save-facts', async () => {
    const m = state.caseView.matter;
    const updates = {};
    document.querySelectorAll('[data-fact]').forEach(i => {
        const old = i.type === 'date' ? getFact(m, i.dataset.fact).slice(0, 10) : getFact(m, i.dataset.fact);
        if (i.value !== old) updates[i.dataset.fact] = i.value;
    });
    if (!Object.keys(updates).length) return closeModal();
    try {
        const r = await saveFacts(updates);
        closeModal();
        toast(`Saved ${r.changed.length} change${r.changed.length === 1 ? '' : 's'}${r.rejected.length ? ' — skipped: ' + r.rejected.join(', ') : ''}`, r.rejected.length ? 'warn' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
});

action('add-reminder', () => {
    modal('Add reminder', `<div class="fgrid"><div class="full"><label class="lbl">What</label><input class="input" id="rmTitle" placeholder="e.g. Follow up with process server"></div>
        <div><label class="lbl">Date</label><input class="input" id="rmDate" type="date"></div><div><label class="lbl">Notes</label><input class="input" id="rmNotes"></div></div>`,
        `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="save-reminder">Add</button>`);
});
action('save-reminder', async () => {
    try {
        await api(`/api/cases/${state.caseId}/deadlines`, { json: { title: document.getElementById('rmTitle').value, date: document.getElementById('rmDate').value, notes: document.getElementById('rmNotes').value } });
        closeModal(); await reloadCase();
    } catch (e) { toast(e.message, 'err'); }
});
action('toggle-reminder', async d => {
    try { await api(`/api/cases/${state.caseId}/deadlines/${d.id}`, { method: 'PATCH', json: { done: !!d.done } }); await reloadCase(); } catch (e) { toast(e.message, 'err'); }
});
action('delete-reminder', async d => {
    if (!confirm('Delete this reminder?')) return;
    try { await api(`/api/cases/${state.caseId}/deadlines/${d.id}`, { method: 'DELETE' }); await reloadCase(); } catch (e) { toast(e.message, 'err'); }
});

// ---------- case menu ----------
action('case-menu', () => {
    const m = state.caseView.matter;
    modal('Case actions', `<div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn secondary" style="justify-content:flex-start" data-act="reanalyze">${icon('refresh')}Re-analyze — rebuild summary and facts from every document</button>
        <button class="btn secondary" style="justify-content:flex-start" data-act="toggle-closed">${icon('check')}${m.status === 'closed' ? 'Reopen case' : 'Close case'}</button>
        <button class="btn danger" style="justify-content:flex-start" data-act="delete-case">${icon('x')}Delete case and all its documents</button></div>`);
});
action('reanalyze', async () => {
    closeModal();
    const id = state.caseId;
    toast('Re-analyzing the case…', 'info');
    try {
        await drive(id);
        await api(`/api/matters/${id}/rebuild-from-documents`, { method: 'POST' });
        toast('Case updated from documents');
        await reloadCase(id);
    } catch (e) { toast(e.message, 'err'); }
});
action('toggle-closed', async () => {
    closeModal();
    const closed = state.caseView.matter.status === 'closed';
    try { await saveFacts({ status: closed ? 'active' : 'closed' }); toast(closed ? 'Case reopened' : 'Case closed'); } catch (e) { toast(e.message, 'err'); }
});
action('delete-case', async () => {
    const m = state.caseView.matter;
    const typed = prompt(`This permanently deletes the case and all ${state.caseView.documents.length} documents.\nType the defendant's last name to confirm:`);
    if (!typed) return;
    if (!String(m.debtorName || '').toLowerCase().includes(typed.trim().toLowerCase())) return toast('Name did not match — nothing deleted', 'warn');
    try {
        await api(`/api/matters/${m.id}`, { method: 'DELETE' });
        closeModal(); toast('Case deleted');
        state.caseId = null; state.caseView = null;
        location.hash = '#/cases';
    } catch (e) { toast(e.message, 'err'); }
});

// Background reading progress → refresh the open case
on('queue', r => {
    if (!state.caseId) return;
    const touched = (r.rebuilt || []).some(x => x.id === state.caseId) || (r.processed || []).some(p => p.matterId === state.caseId);
    if (touched) reloadCase(state.caseId);
    else renderBanners();
});
on('schema', () => renderBanners());
on('cases-changed', ids => { if (state.caseId && ids.includes(state.caseId)) reloadCase(state.caseId); });

export { renderHead, renderTab };
