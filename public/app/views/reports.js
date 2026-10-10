// ============================================================
// Client status report — every case for Kinecta, printable and exportable
// ============================================================
import { api, esc, icon, toast, action, fmtDate, fmtMoney, openFile, statusChip } from '../core.js';

const rep = { since: '', closed: false };

export async function renderReports(view) {
    view.innerHTML = `<div class="empty">Loading…</div>`;
    let d;
    const qs = `?${rep.since ? 'since=' + rep.since + '&' : ''}${rep.closed ? 'closed=1' : ''}`;
    try { d = await api(`/api/reports/portfolio${qs}`); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const totals = d.rows.reduce((t, r) => {
        const n = v => parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')) || 0;
        t.demand += n(r.demand); t.judgment += n(r.judgment); return t;
    }, { demand: 0, judgment: 0 });
    const byStage = {};
    d.rows.forEach(r => { byStage[r.stage] = (byStage[r.stage] || 0) + 1; });
    view.innerHTML = `
        <div class="pagehead"><div><h1 class="h1">Client status report</h1><p class="sub">Kinecta Federal Credit Union · ${esc(fmtDate(d.generated))} · ${d.rows.length} case${d.rows.length === 1 ? '' : 's'}</p></div>
            <div class="right no-print">
                <label class="small muted">Activity since <input class="input" type="date" id="repSince" value="${esc(rep.since)}" style="width:150px;display:inline-block;margin-left:4px"></label>
                <button class="btn ghost sm" data-act="rep-closed">${rep.closed ? 'Hide closed' : 'Include closed'}</button>
                <button class="btn secondary" data-act="rep-print">${icon('file')}Print / PDF</button>
                <button class="btn primary" data-act="rep-xlsx">${icon('download')}Excel</button>
            </div></div>
        <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
            <div class="tile"><div class="n">${d.rows.length}</div><div class="l">Cases</div></div>
            <div class="tile"><div class="n">${esc(fmtMoney(totals.demand))}</div><div class="l">Total demanded</div></div>
            <div class="tile"><div class="n">${esc(fmtMoney(totals.judgment))}</div><div class="l">Total in judgments</div></div>
            <div class="tile"><div class="n" style="font-size:14px;line-height:1.5">${Object.entries(byStage).map(([s, n]) => `${esc(s)}: <b>${n}</b>`).join('<br>') || '—'}</div><div class="l">By stage</div></div>
        </div>
        <div class="card flush">${d.rows.length ? `<table class="tbl"><thead><tr><th>Debtor / case</th><th>Stage</th><th>Key dates</th><th class="num">Demand / judgment</th><th>Status &amp; last action</th><th>Next step</th></tr></thead><tbody>
            ${d.rows.map(r => `<tr data-act="go" data-href="#/case/${r.id}/overview">
                <td><b>${esc(r.debtor)}</b><div class="muted small">${esc(r.caseNumber || 'not filed')}${r.account ? ' · acct ' + esc(r.account) : ''}</div><div class="muted small">${esc(r.court)}</div></td>
                <td><span class="chip blue">${esc(r.stage)}</span>${r.closed ? ' <span class="chip">Closed</span>' : ''}</td>
                <td class="small">${[['Filed', r.filed], ['Served', r.served], ['Default', r.defaultEntered], ['Judgment', r.judgmentEntered]].filter(x => x[1]).map(([l, v]) => `${l} ${esc(fmtDate(v, { short: false }))}`).join('<br>') || '—'}</td>
                <td class="num">${r.demand ? esc(fmtMoney(r.demand)) : '—'}${r.judgment ? `<div class="small">J: ${esc(fmtMoney(r.judgment))}</div>` : ''}</td>
                <td style="max-width:320px">${esc(r.status || '—')}${r.lastAction ? `<div class="muted small" style="margin-top:3px">Last: ${esc(r.lastAction)}${r.lastActionDate ? ' (' + esc(fmtDate(r.lastActionDate)) + ')' : ''}</div>` : ''}
                    ${rep.since && r.changesSince.length ? `<div class="small" style="margin-top:4px;color:var(--accent-primary)">Since ${esc(fmtDate(rep.since))}: ${r.changesSince.map(esc).join('; ')}</div>` : ''}</td>
                <td style="max-width:260px">${esc(r.nextStep || '—')}${r.nextDate ? `<div style="margin-top:3px">${statusChip(r.nextStatus)} <span class="small">${esc(fmtDate(r.nextDate))}</span></div>` : ''}</td>
            </tr>`).join('')}</tbody></table>` : '<div class="empty">No cases.</div>'}</div>
        <p class="muted small">Status text comes from each case's “Note for client status report” (Notes tab) or, if blank, the AI status from its documents.</p>`;
    document.getElementById('repSince').addEventListener('change', e => { rep.since = e.target.value; renderReports(view); });
}

action('rep-closed', () => { rep.closed = !rep.closed; renderReports(document.getElementById('view')); });
action('rep-print', () => window.print());
action('rep-xlsx', () => openFile(`/api/reports/portfolio.xlsx?${rep.since ? 'since=' + rep.since + '&' : ''}${rep.closed ? 'closed=1' : ''}`, { inline: false, name: 'Kinecta status report.xlsx' }));
