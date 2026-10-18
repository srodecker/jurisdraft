// ============================================================
// Forms: catalog, prepare from a case, review/edit values, regenerate
// ============================================================
import { api, state, esc, fmtDate, varLabel, icon, toast, modal, closeModal, action, openFile, emit } from '../core.js';

export async function loadForms() {
    if (!state.forms.length) state.forms = await api('/api/forms');
    return state.forms;
}

const STAGE_FORMS = {
    intake: ['SUM-100.pdf', 'CM-010.pdf', 'LASC.pdf'],
    filed: [], served: [],
    default_window: ['CIV-100 (R4D).pdf'],
    default_requested: [],
    default_entered: ['CIV-100.pdf', 'POS_Def_Package.docx', 'CIV-110 (Dismissal).pdf'],
    judgment: ['EJ-001.pdf']
};

let packages = [];
async function loadPackages() {
    if (!packages.length) packages = await api('/api/forms/packages');
    return packages;
}

export async function renderCaseForms(body) {
    const v = state.caseView, m = v.matter;
    let forms = [];
    try { [forms] = await Promise.all([loadForms(), loadPackages()]); } catch (e) { toast(e.message, 'err'); }
    if (!document.body.contains(body)) return;
    const suggest = STAGE_FORMS[v.stage.key] || [];
    const gen = m.generatedForms || [];
    body.innerHTML = `
        <div class="card"><div class="card-h">${icon('file')} Prepared for this case</div>
            ${gen.length ? gen.map(f => `<div class="row link" data-act="show-form" data-case="${m.id}" data-form="${f.id}">
                <div class="grow"><div class="t">${esc(f.code)} — ${esc(f.title)}${f.engine === 'v2' ? ' <span class="muted small">· v2</span>' : ''}</div><div class="d">${esc(fmtDate(String(f.createdAt).slice(0, 10)))} · ${esc(f.createdBy || '')} · ${f.filledCount || 0} fields${f.missing && f.missing.length ? ` · <span style="color:var(--amber)">${f.missing.length} key field${f.missing.length === 1 ? '' : 's'} blank</span>` : ' · key fields filled'}</div></div>
                <button class="btn ghost sm" data-act="form-open" data-stop data-case="${m.id}" data-form="${f.id}">${icon('eye')}Open</button></div>`).join('')
            : '<div class="empty">Nothing prepared yet.</div>'}
        </div>
        <div class="card"><div class="card-h">Filing packages <span class="r muted">every form for a step, prepared in one click</span></div>
            <div class="formgrid">${packages.map(p => `<div class="fcard ${p.stage === v.stage.key ? 'sug' : ''}">
                <div class="c">${p.stage === v.stage.key ? 'SUGGESTED NOW · ' : ''}${p.forms.length} FORM${p.forms.length === 1 ? '' : 'S'}</div><div class="n">${esc(p.title)}</div><div class="p">${esc(p.purpose)}<br><span class="small">${p.forms.map(f => esc(f.code)).join(' · ')}</span></div>
                <div><button class="btn ${p.stage === v.stage.key ? 'primary' : 'secondary'} sm" data-act="prepare-package" data-case="${m.id}" data-pkg="${p.id}">Prepare package</button></div></div>`).join('')}</div>
        </div>
        <div class="card"><div class="card-h">Prepare a single form <span class="r muted">filled from this case and your firm settings — review before filing</span></div>
            <div class="formgrid">${forms.map(f => `<div class="fcard ${suggest.includes(f.file) ? 'sug' : ''}">
                <div class="c">${esc(f.code)}${suggest.includes(f.file) ? ' · SUGGESTED NOW' : ''}</div><div class="n">${esc(f.title)}</div><div class="p">${esc(f.purpose)}</div>
                <div><button class="btn ${suggest.includes(f.file) ? 'primary' : 'secondary'} sm" data-act="prepare-form" data-case="${m.id}" data-form="${esc(f.file)}">Prepare</button></div></div>`).join('')}</div>
        </div>`;
}

export async function renderFormsCatalog(view) {
    view.innerHTML = `<div class="empty">Loading…</div>`;
    let forms = [];
    try { forms = await loadForms(); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    view.innerHTML = `<div class="pagehead"><div><h1 class="h1">Forms</h1><p class="sub">Judicial Council and local forms filled from a case. Open a case → Forms, use a case's Next step, or tell the assistant (“prepare the abstract of judgment for Acevedo”).</p></div></div>
        <div class="formgrid">${forms.map(f => `<div class="fcard"><div class="c">${esc(f.code)}</div><div class="n">${esc(f.title)}</div><div class="p">${esc(f.purpose)}</div><div class="small muted">Stage: ${esc(f.stage)}</div></div>`).join('')}</div>`;
}

// A choice the documents can't settle (who signs, nicknames): the server answers 409 with questions.
// Ask them, optionally remember the answers, and send the request again.
function askChoices(questions) {
    return new Promise(resolve => {
        modal('Before filling', `
            ${questions.map(q => `<div class="field" style="margin-bottom:14px"><div class="t" style="margin-bottom:6px">${esc(q.question)}</div>
                ${q.options.map((o, i) => `<label class="row" style="cursor:pointer;gap:8px"><input type="radio" name="q-${esc(q.id)}" value="${esc(o.value)}" ${i === 0 ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}</div>`).join('')}
            <label class="row small" style="cursor:pointer;gap:8px"><input type="checkbox" id="qRemember" checked>Remember my answers (change them in Settings)</label>`,
            `<button class="btn ghost" data-act="choices-cancel">Cancel</button><button class="btn primary" data-act="choices-ok">Fill form</button>`);
        pendingChoices = { questions, resolve };
    });
}
let pendingChoices = null;
action('choices-ok', () => {
    if (!pendingChoices) return;
    const { questions, resolve } = pendingChoices;
    const answers = {};
    for (const q of questions) { const el = document.querySelector(`input[name="q-${q.id}"]:checked`); if (el) answers[q.id] = el.value; }
    const remember = !!(document.getElementById('qRemember') || {}).checked;
    pendingChoices = null; closeModal(); resolve({ answers, remember });
});
action('choices-cancel', () => { if (pendingChoices) { pendingChoices.resolve(null); pendingChoices = null; } closeModal(); });

// POST that may need answers first
async function postAsking(url, body) {
    try { return await api(url, { json: { ...body, ask: true } }); }
    catch (e) {
        if (e.status !== 409 || !e.data || !e.data.questions) throw e;
        const picked = await askChoices(e.data.questions);
        if (!picked) throw new Error('Cancelled');
        return api(url, { json: { ...body, ask: true, ...picked } });
    }
}

async function prepare(caseId, file, values) {
    toast('Preparing form…', 'info', 2000);
    const rec = await postAsking(`/api/cases/${caseId}/forms`, { form: file, values });
    emit('cases-changed', [caseId]);
    return rec;
}

action('prepare-package', async d => {
    toast('Preparing package…', 'info', 2500);
    try {
        const r = await postAsking(`/api/cases/${d.case}/packages`, { package: d.pkg });
        emit('cases-changed', [d.case]);
        const pdfIds = r.records.filter(x => /pdf/.test(x.contentType || '')).map(x => x.id);
        const blanks = r.records.reduce((n, x) => n + (x.missing || []).length, 0);
        modal(r.title, `
            ${blanks ? `<div class="banner">${icon('warn')}<div>${blanks} key field${blanks === 1 ? '' : 's'} blank across these forms — open each to fill them in, or set firm details once in Settings.</div></div>` : '<div class="banner info">' + icon('check') + '<div>All key fields filled. Review before filing.</div></div>'}
            ${r.errors.length ? `<div class="banner err">${icon('warn')}<div>${r.errors.map(esc).join('<br>')}</div></div>` : ''}
            ${r.records.map(x => `<div class="row link" data-act="show-form" data-case="${d.case}" data-form="${x.id}"><div class="grow"><div class="t">${esc(x.code)} — ${esc(x.title)}</div><div class="d">${x.filledCount || 0} fields${x.missing && x.missing.length ? ` · <span style="color:var(--amber)">${x.missing.length} blank: ${esc(x.missing.map(varLabel).join(', '))}</span>` : ' · key fields filled'}</div></div>${icon('arrow')}</div>`).join('')}`,
            pdfIds.length > 1 ? `<button class="btn ghost" data-act="close-modal">Close</button><button class="btn primary" data-act="open-merged" data-case="${d.case}" data-ids="${pdfIds.join(',')}">${icon('eye')}Open all PDFs as one</button>` : `<button class="btn ghost" data-act="close-modal">Close</button>`);
    } catch (e) { toast(e.message, 'err'); }
});
action('open-merged', d => openFile(`/api/cases/${d.case}/forms-merged?inline=1&ids=${d.ids}`, { inline: true }));

action('prepare-form', async d => {
    try { showRecord(d.case, await prepare(d.case, d.form)); } catch (e) { toast(e.message, 'err'); }
});

async function findRecord(caseId, formId) {
    if (state.caseView && state.caseId === caseId) {
        const r = (state.caseView.matter.generatedForms || []).find(f => f.id === formId);
        if (r) return r;
    }
    const v = await api(`/api/cases/${caseId}`);
    return (v.matter.generatedForms || []).find(f => f.id === formId);
}

action('show-form', async d => {
    try {
        const rec = await findRecord(d.case, d.form);
        if (!rec) return toast('That form was deleted', 'warn');
        showRecord(d.case, rec);
    } catch (e) { toast(e.message, 'err'); }
});
action('form-open', d => openFile(`/api/cases/${d.case}/forms/${d.form}/download?inline=1`, { inline: true }));

let editing = null;
function showRecord(caseId, rec) {
    editing = { caseId, rec };
    const filled = Object.entries(rec.filled || {});
    const missing = rec.missing || [];
    const isDocx = (rec.contentType || '').includes('word');
    modal(`${rec.code} — ${rec.title}`, `
        <div class="muted small" style="margin-bottom:12px">Prepared ${esc(fmtDate(String(rec.createdAt).slice(0, 10)))} by ${esc(rec.createdBy || '')} · ${rec.filledCount || 0} fields filled · edit any value below and regenerate</div>
        ${missing.length ? `<div class="banner">${icon('warn')}<div><b>${missing.length} key field${missing.length === 1 ? '' : 's'} blank.</b> Fill them in below and click Regenerate — or set firm details once in Settings.</div></div>` : ''}
        <div class="kv" id="formVals">
            ${missing.map(k => `<div title="${esc(k)}"><b style="color:var(--amber)">${esc(varLabel(k))}</b></div><div><input class="input" data-var="${esc(k)}" placeholder="blank"></div>`).join('')}
            ${filled.map(([k, v]) => `<div title="${esc(k)}">${esc(varLabel(k))}</div><div>${/^\[VAR_/.test(k) ? `<span class="small">${esc(v)}</span>` : `<input class="input" data-var="${esc(k)}" value="${esc(v)}">`}</div>`).join('')}
        </div>
        <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="formRemember" checked> Remember my changes for this case's future forms</label>`,
        `<button class="btn ghost danger" data-act="form-delete">Delete</button><span style="flex:1"></span>
         <button class="btn ghost" data-act="form-dl">${icon('download')}Download</button>
         <button class="btn secondary" data-act="form-regen">${icon('refresh')}Regenerate</button>
         <button class="btn primary" data-act="form-view">${icon('eye')}Open ${isDocx ? 'document' : 'PDF'}</button>`, { wide: true });
}

action('form-view', () => openFile(`/api/cases/${editing.caseId}/forms/${editing.rec.id}/download?inline=1`, { inline: true }));
action('form-dl', () => openFile(`/api/cases/${editing.caseId}/forms/${editing.rec.id}/download`, { inline: false, name: editing.rec.fileName }));
action('form-regen', async () => {
    const { caseId, rec } = editing;
    const values = {};
    document.querySelectorAll('#formVals [data-var]').forEach(i => {
        const before = (rec.filled || {})[i.dataset.var] || '';
        if (i.value.trim() !== String(before)) values[i.dataset.var] = i.value.trim();
    });
    try {
        if (Object.keys(values).length && document.getElementById('formRemember').checked) {
            await api(`/api/cases/${caseId}/facts`, { method: 'PATCH', json: { updates: values } });
        }
        const fresh = await prepare(caseId, rec.form, { ...(rec.values || {}), ...values });
        showRecord(caseId, fresh);
        toast('Regenerated');
    } catch (e) { toast(e.message, 'err'); }
});
action('form-delete', async () => {
    if (!confirm('Delete this prepared form?')) return;
    try {
        await api(`/api/cases/${editing.caseId}/forms/${editing.rec.id}`, { method: 'DELETE' });
        closeModal(); toast('Deleted'); emit('cases-changed', [editing.caseId]);
    } catch (e) { toast(e.message, 'err'); }
});
