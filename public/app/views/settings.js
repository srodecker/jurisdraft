// ============================================================
// Settings: firm + attorneys (fill every form), system status
// ============================================================
import { api, esc, icon, toast, action } from '../core.js';

let profile = null;

export async function renderSettings(view) {
    view.innerHTML = `<div class="empty">Loading…</div>`;
    let status = null;
    try { profile = await api('/api/profile'); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    try { status = await api('/api/system/status'); } catch (_) {}
    let prefs = { items: [] };
    try { prefs = await api('/api/form-prefs'); } catch (_) {}
    const f = profile.firm || {};
    const atts = (profile.attorneys && profile.attorneys.length ? profile.attorneys : [{}, {}]).concat([{}]).slice(0, Math.max(2, (profile.attorneys || []).length + 1));
    view.innerHTML = `
        <div class="pagehead"><div><h1 class="h1">Settings</h1><p class="sub">Your firm and attorneys are filled into every form (caption, signature block, proof of service).</p></div></div>
        <div class="cols">
            <div>
                <div class="card"><div class="card-h">Firm</div>
                    <div class="fgrid">
                        <div class="full"><label class="lbl">Firm name</label><input class="input" data-firm="name" value="${esc(f.name || '')}" placeholder="e.g. Wright, Finlay & Zak, LLP"></div>
                        <div class="full"><label class="lbl">Street address</label><input class="input" data-firm="address" value="${esc(f.address || '')}"></div>
                        <div><label class="lbl">City</label><input class="input" data-firm="city" value="${esc(f.city || '')}"></div>
                        <div style="display:grid;grid-template-columns:70px 1fr;gap:10px"><div><label class="lbl">State</label><input class="input" data-firm="state" value="${esc(f.state || 'CA')}"></div><div><label class="lbl">ZIP</label><input class="input" data-firm="zip" value="${esc(f.zip || '')}"></div></div>
                        <div><label class="lbl">Phone</label><input class="input" data-firm="phone" value="${esc(f.phone || '')}"></div>
                        <div><label class="lbl">Fax</label><input class="input" data-firm="fax" value="${esc(f.fax || '')}"></div>
                    </div>
                </div>
                <div class="card"><div class="card-h">Attorneys <span class="r muted">first = attorney of record</span></div>
                    <div id="attyRows">${atts.map((a, i) => attyRow(a, i)).join('')}</div>
                    <button class="btn ghost sm" data-act="add-atty">${icon('plus')}Add attorney</button>
                </div>
                <div style="display:flex;justify-content:flex-end"><button class="btn primary" data-act="save-settings">Save settings</button></div>
            </div>
            <div>
                <div class="card"><div class="card-h">System status</div>
                    ${status ? `<dl class="facts">
                        <dt>Storage</dt><dd>${status.storage === 'supabase' ? '<span class="chip green">Supabase</span>' : '<span class="chip amber">Local files</span>'}</dd>
                        <dt>AI reading</dt><dd>${status.ai ? '<span class="chip green">Connected</span>' : '<span class="chip err">GOOGLE_API_KEY missing</span>'}</dd>
                        <dt>Database columns</dt><dd>${status.schema && status.schema.ok ? '<span class="chip green">OK</span>' : `<span class="chip err">Needs update</span><div class="small muted" style="margin-top:4px">${esc((status.schema && status.schema.error) || '')}</div>`}</dd>
                        <dt>Documents</dt><dd>${status.docs.total} total · ${status.docs.done} read · ${status.docs.pending} waiting · ${status.docs.error} failed</dd>
                        <dt>Background schedule</dt><dd>${status.cron ? '<span class="chip green">CRON_SECRET set</span>' : '<span class="muted">Reading runs while the app is open</span>'}</dd>
                    </dl>` : '<div class="empty">Status unavailable.</div>'}
                </div>
                <div class="card"><div class="card-h">Form preferences <span class="r muted">learned by asking</span></div>
                    <div id="prefRows">${prefRows(prefs.items)}</div>
                </div>
                <div class="card"><div class="card-h">Signed in</div><p style="margin:0">${esc(profile.username || '')}</p></div>
            </div>
        </div>`;
}

// Answers remembered when a form asked (who signs, nicknames). Forget one and the next form asks again.
function prefRows(items) {
    if (!items.length) return '<p class="small muted" style="margin:0">Nothing yet. When a form needs a choice the documents can\'t settle, it asks you and can remember the answer here.</p>';
    return items.map(p => `<div class="row"><div class="grow"><div class="t">${esc(p.label)}</div><div class="d">${esc(p.value)}</div></div><button class="btn ghost sm" data-act="forget-pref" data-id="${esc(p.id)}">Forget</button></div>`).join('');
}

action('forget-pref', async d => {
    try {
        const r = await api(`/api/form-prefs/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
        document.getElementById('prefRows').innerHTML = prefRows(r.items);
        toast('Forgotten — the next form will ask again', 'ok');
    } catch (e) { toast(e.message, 'err'); }
});

function attyRow(a, i) {
    return `<div class="fgrid atty" style="grid-template-columns:2fr 1fr 2fr;margin-bottom:10px">
        <div><label class="lbl">Name ${i === 0 ? '(of record)' : ''}</label><input class="input" data-atty="name" value="${esc(a.name || '')}" placeholder="Full name"></div>
        <div><label class="lbl">State Bar #</label><input class="input" data-atty="sbn" value="${esc(a.sbn || '')}"></div>
        <div><label class="lbl">Email</label><input class="input" data-atty="email" value="${esc(a.email || '')}"></div></div>`;
}

action('add-atty', () => {
    const box = document.getElementById('attyRows');
    box.insertAdjacentHTML('beforeend', attyRow({}, box.children.length));
});

action('save-settings', async () => {
    const firm = {};
    document.querySelectorAll('[data-firm]').forEach(i => { firm[i.dataset.firm] = i.value.trim(); });
    const attorneys = [...document.querySelectorAll('.atty')].map(row => {
        const a = {};
        row.querySelectorAll('[data-atty]').forEach(i => { a[i.dataset.atty] = i.value.trim(); });
        return a;
    }).filter(a => a.name);
    try {
        profile = await api('/api/profile', { method: 'PUT', json: { firm, attorneys } });
        toast('Settings saved — new forms will use them');
    } catch (e) { toast(e.message, 'err'); }
});
