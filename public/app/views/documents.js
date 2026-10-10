// ============================================================
// Documents tab: upload, list, in-app preview and "what the AI read"
// ============================================================
import { api, state, esc, fmtDate, bytes, icon, toast, action, authHeaders, viewUrl, openFile, debounce } from '../core.js';
import { drive } from '../queue.js';
import { reloadCase } from './case.js';

const view = { mode: 'read', quote: '', filter: '', textCache: new Map(), urlCache: new Map() };

function ext(name) { return String(name).split('.').pop().toLowerCase().slice(0, 4); }
function statusChip(x) {
    if (x.analysisStatus === 'done') return `<span class="chip green">${x.isDraft ? 'Draft' : 'Read'}</span>`;
    if (x.analysisStatus === 'reading') return '<span class="chip blue">Reading…</span>';
    if (x.analysisStatus === 'unsupported') return '<span class="chip">Not readable</span>';
    if (x.analysisStatus === 'error') return `<span class="chip err">${/missing|not found/i.test(x.analysisError || '') ? 'File missing' : 'Failed'}</span>`;
    return `<span class="chip amber">${x.attempts ? 'Retrying' : 'Queued'}</span>`;
}

export function renderDocuments(body, { soft } = {}) {
    const v = state.caseView;
    const docs = [...v.documents].sort((a, b) => String(b.documentDate || b.createdAt).localeCompare(String(a.documentDate || a.createdAt)));
    if (!state.docSel || !docs.some(d => d.id === state.docSel)) state.docSel = docs[0] ? docs[0].id : null;
    // Soft refresh: keep the viewer (iframe) if the same document is open
    const keepViewer = soft && document.getElementById('docViewer') && document.getElementById('docViewer').dataset.doc === state.docSel;
    const listHtml = docList(docs);
    if (keepViewer) {
        document.getElementById('docList').innerHTML = listHtml;
        renderViewerHead(docs.find(d => d.id === state.docSel));
        if (view.mode === 'read') renderRead(docs.find(d => d.id === state.docSel));
        return;
    }
    body.innerHTML = `<div class="docs">
        <div>
            <div class="drop" data-act="pick-files"><b>Drop files here</b> or click to upload<div class="small">PDF, scans, Word, Outlook .msg / .eml · up to 50 MB each</div></div>
            <input class="input" id="docFilter" placeholder="Filter documents…" value="${esc(view.filter)}" style="margin-bottom:8px">
            <div class="card flush"><div class="doclist" id="docList">${listHtml}</div></div>
        </div>
        <div class="viewer" id="docViewer" data-doc="${esc(state.docSel || '')}">${docs.length ? '' : '<div class="card"><div class="empty">No documents yet.</div></div>'}</div>
    </div>`;
    document.getElementById('docFilter').addEventListener('input', debounce(e => { view.filter = e.target.value; document.getElementById('docList').innerHTML = docList(docs); }, 120));
    if (state.docSel) openViewer(docs.find(d => d.id === state.docSel));
}

function docList(docs) {
    const q = view.filter.toLowerCase();
    const list = docs.filter(d => !q || `${d.fileName} ${d.documentType || ''}`.toLowerCase().includes(q));
    if (!list.length) return '<div class="empty">No documents match.</div>';
    return list.map(d => `<div class="docitem ${d.id === state.docSel ? 'on' : ''}" data-act="doc-select" data-id="${d.id}">
        <div class="ext ${ext(d.fileName)}">${esc(ext(d.fileName).toUpperCase())}</div>
        <div style="flex:1;min-width:0"><div class="nm" title="${esc(d.fileName)}">${esc(d.fileName)}</div><div class="ty">${esc(d.documentType || '')}${d.documentDate ? ' · ' + esc(fmtDate(d.documentDate, { short: false })) : ''}</div></div>
        ${statusChip(d)}</div>`).join('');
}

function renderViewerHead(d) {
    const head = document.getElementById('docHead');
    if (!head || !d) return;
    head.innerHTML = `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">
        <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px;overflow-wrap:anywhere">${esc(d.fileName)}</div>
            <div class="muted small">${esc(d.documentType || 'Not read yet')}${d.documentDate ? ' · dated ' + esc(fmtDate(d.documentDate)) : ''} · uploaded ${esc(fmtDate(String(d.createdAt).slice(0, 10)))}${d.size ? ' · ' + bytes(d.size) : ''}${d.filedWithCourt ? ' · court-filed' : ''}${d.isDraft ? ' · draft / unfiled' : ''}</div></div>
        ${statusChip(d)}
    </div>
    ${d.analysisStatus === 'error' || (d.analysisStatus === 'queued' && d.analysisError) ? `<div class="banner ${d.analysisStatus === 'error' ? 'err' : ''}">${icon('warn')}<div style="flex:1">${esc(d.analysisError || 'Could not be read')}</div>${d.analysisStatus === 'error' ? `<button class="btn secondary sm" data-act="doc-retry" data-id="${d.id}">Retry</button>` : ''}</div>` : ''}
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <div class="seg"><button class="${view.mode === 'read' ? 'on' : ''}" data-act="doc-mode" data-mode="read">What the AI read</button><button class="${view.mode === 'preview' ? 'on' : ''}" data-act="doc-mode" data-mode="preview">Original</button></div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" data-act="doc-open" data-id="${d.id}">${icon('eye')}Open</button>
        <button class="btn ghost sm" data-act="doc-download" data-id="${d.id}">${icon('download')}Download</button>
        ${d.analysisStatus === 'done' ? `<button class="btn ghost sm" data-act="doc-recheck" data-id="${d.id}" title="Read the stored text again for facts">${icon('refresh')}Re-check</button>` : ''}
        <button class="btn ghost sm" data-act="doc-rename" data-id="${d.id}">Rename</button>
        <button class="btn ghost sm danger" data-act="doc-remove" data-id="${d.id}">Remove</button>
    </div>`;
}

async function openViewer(d) {
    const box = document.getElementById('docViewer');
    if (!box || !d) return;
    box.dataset.doc = d.id;
    box.innerHTML = `<div class="card"><div id="docHead"></div><div id="docPane"></div></div>`;
    renderViewerHead(d);
    if (view.mode === 'preview') renderPreview(d); else renderRead(d);
}

async function renderRead(d) {
    const pane = document.getElementById('docPane');
    if (!pane || !d) return;
    const facts = d.extracted || [];
    pane.innerHTML = `
        ${d.summary ? `<p class="summary" style="font-size:13px">${esc(d.summary)}</p>` : `<p class="muted">${d.analysisStatus === 'done' ? 'No summary.' : 'This document has not been read yet.'}</p>`}
        ${(d.keyFacts || []).length ? `<ul class="keyfacts" style="margin-bottom:12px">${d.keyFacts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${facts.length ? `<div class="card-h" style="margin-top:14px">Facts found in this document</div><dl class="extracted">${facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(/^dates\.|Date$/.test(f.key) ? fmtDate(f.value) : f.value)}${f.quote ? `<a class="q" href="#" data-act="doc-quote" data-quote="${esc(f.quote)}">“${esc(f.quote)}”</a>` : ''}</dd>`).join('')}</dl>` : ''}
        ${d.textChars ? `<div class="card-h" style="margin-top:16px">Full text <span class="r muted">${d.textChars.toLocaleString()} characters</span></div><div class="readtext" id="docText">Loading…</div>` : ''}`;
    if (!d.textChars) return;
    let text = view.textCache.get(d.id);
    if (text === undefined) {
        try { text = (await api(`/api/matters/${state.caseId}/documents/${d.id}/text`)).text; view.textCache.set(d.id, text); }
        catch (e) { text = `Could not load text: ${e.message}`; }
    }
    const el = document.getElementById('docText');
    if (!el || document.getElementById('docViewer').dataset.doc !== d.id) return;
    el.innerHTML = highlight(text, view.quote);
    const mark = el.querySelector('mark');
    if (mark) mark.scrollIntoView({ block: 'center' });
}

// Highlight a quote in the text, tolerant of whitespace and punctuation differences
function highlight(text, quote) {
    const safe = esc(text);
    if (!quote) return safe;
    const words = String(quote).replace(/[“”"]/g, '').split(/\s+/).filter(Boolean).slice(0, 12).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return safe;
    try {
        const re = new RegExp(words.map(w => esc(w).replace(/&amp;/g, '&(?:amp;)?')).join('[\\s\\S]{0,6}?'), 'i');
        return safe.replace(re, m => `<mark>${m}</mark>`);
    } catch (_) { return safe; }
}

async function renderPreview(d) {
    const pane = document.getElementById('docPane');
    if (!pane) return;
    const e = ext(d.fileName);
    const viewable = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt'].includes(e) || /^image\/|pdf/.test(d.mimeType || '');
    if (!viewable) {
        pane.innerHTML = `<div class="banner info">${icon('file')}<div>${esc(e.toUpperCase())} files can't be shown in the browser — the text the AI read is under “What the AI read”. Use Download to open it in Outlook or Word.</div></div>`;
        return;
    }
    pane.innerHTML = `<div class="empty">Loading preview…</div>`;
    try {
        let url = view.urlCache.get(d.id);
        if (!url) { url = await viewUrl(`/api/matters/${state.caseId}/documents/${d.id}/download?inline=1`); view.urlCache.set(d.id, url); setTimeout(() => view.urlCache.delete(d.id), 8 * 60 * 1000); }
        if (document.getElementById('docViewer').dataset.doc !== d.id) return;
        pane.innerHTML = /^image\//.test(d.mimeType || '') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)
            ? `<img src="${esc(url)}" style="max-width:100%;border-radius:8px" alt="${esc(d.fileName)}">`
            : `<iframe class="viewer-frame" src="${esc(url)}" title="${esc(d.fileName)}"></iframe>`;
    } catch (err) {
        pane.innerHTML = `<div class="banner err">${icon('warn')}<div>${esc(err.message)}</div></div>`;
    }
}

function current() { return state.caseView.documents.find(d => d.id === state.docSel); }

action('doc-select', d => {
    state.docSel = d.id;
    view.quote = '';
    history.replaceState(null, '', `#/case/${state.caseId}/documents/${d.id}`);
    document.querySelectorAll('.docitem').forEach(el => el.classList.toggle('on', el.dataset.id === d.id));
    openViewer(current());
});
action('doc-mode', d => { view.mode = d.mode; const doc = current(); renderViewerHead(doc); if (view.mode === 'preview') renderPreview(doc); else renderRead(doc); });
action('doc-quote', d => { view.quote = d.quote; renderRead(current()); });
action('doc-open', d => openFile(`/api/matters/${state.caseId}/documents/${d.id}/download?inline=1`, { inline: true }));
action('doc-download', d => { const doc = state.caseView.documents.find(x => x.id === d.id); openFile(`/api/matters/${state.caseId}/documents/${d.id}/download`, { inline: false, name: doc ? doc.fileName : 'document' }); });
action('doc-retry', async d => { await retry(d.id, {}); });
action('doc-recheck', async d => { await retry(d.id, { reextract: true }); toast('Re-checking this document…', 'info'); });
action('doc-rename', async d => {
    const doc = state.caseView.documents.find(x => x.id === d.id);
    const name = prompt('Rename document', doc ? doc.fileName : '');
    if (!name || !doc || name === doc.fileName) return;
    try { await api(`/api/matters/${state.caseId}/documents/${d.id}`, { method: 'PATCH', json: { fileName: name } }); await reloadCase(); } catch (e) { toast(e.message, 'err'); }
});
action('doc-remove', async d => {
    const doc = state.caseView.documents.find(x => x.id === d.id);
    if (!doc || !confirm(`Remove "${doc.fileName}" from this case?`)) return;
    try {
        await api(`/api/matters/${state.caseId}/documents/${d.id}`, { method: 'DELETE' });
        toast('Removed — updating the case');
        state.docSel = null;
        await reloadCase();
        drive(state.caseId);
    } catch (e) { toast(e.message, 'err'); }
});
async function retry(id, body) {
    try { await api(`/api/matters/${state.caseId}/documents/${id}/retry`, { json: body }); await reloadCase(); drive(state.caseId); }
    catch (e) { toast(e.message, 'err'); }
}

// Jump from a fact's source chip to the document with the quote highlighted
action('open-source', d => {
    if (!d.doc) return;
    state.docSel = d.doc;
    view.mode = 'read';
    view.quote = d.quote || '';
    location.hash = `#/case/${state.caseId}/documents/${d.doc}`;
});

// ---------- uploads (button, drop zone, or drop anywhere on a case page) ----------
const MAX = 50 * 1024 * 1024;
let uploading = false;

action('pick-files', () => {
    if (!state.caseId) return toast('Open a case first', 'warn');
    const p = document.getElementById('filePicker');
    p.onchange = () => { const files = [...p.files]; p.value = ''; upload(files); };
    p.click();
});

let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove('dragging');
    if (state.caseId && location.hash.startsWith('#/case/')) upload([...e.dataTransfer.files]);
    else toast('Open a case first, then drop its documents', 'warn');
});

function xhr(method, url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(method, url);
        Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
        x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch (_) {} if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error(d.error || d.message || `Upload failed (HTTP ${x.status})`)); };
        x.onerror = () => reject(new Error('Network error during upload'));
        x.send(body);
    });
}

async function uploadOne(caseId, file, onProgress) {
    const init = await api(`/api/matters/${caseId}/documents/init`, { json: { fileName: file.name, size: file.size, mimeType: file.type } });
    if (!init.direct) {
        const form = new FormData();
        form.append('files', file);
        await xhr('POST', `/api/matters/${caseId}/documents`, form, authHeaders(), onProgress);
        return;
    }
    await xhr('PUT', init.signedUrl, file, { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'max-age=3600' }, onProgress);
    await api(`/api/matters/${caseId}/documents/complete`, { json: { docId: init.docId, fileName: file.name, mimeType: file.type } });
}

function setUploadBanner(html) {
    const el = document.getElementById('caseBanners');
    if (!el) return;
    let b = document.getElementById('uploadBanner');
    if (!html) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'uploadBanner'; b.className = 'banner info'; el.prepend(b); }
    b.innerHTML = `<div class="spin"></div><div style="flex:1">${html}</div>`;
}

export async function upload(files) {
    const caseId = state.caseId;
    const bad = files.filter(f => !f.size || f.size > MAX);
    files = files.filter(f => f.size > 0 && f.size <= MAX);
    if (bad.length) toast(`Skipped ${bad.map(f => f.name).join(', ')} (empty, a folder, or over 50 MB)`, 'warn');
    if (!caseId || !files.length) return;
    if (uploading) return toast('An upload is already running', 'warn');
    uploading = true;
    let ok = 0;
    const failed = [];
    try {
        for (let i = 0; i < files.length; i++) {
            const label = `Uploading ${i + 1} of ${files.length}: <b>${esc(files[i].name)}</b>`;
            setUploadBanner(label);
            try { await uploadOne(caseId, files[i], p => setUploadBanner(`${label} — ${Math.round(p * 100)}%`)); ok++; }
            catch (e) { failed.push(`${files[i].name}: ${e.message}`); }
        }
    } finally { uploading = false; setUploadBanner(''); }
    if (failed.length) toast(`Not uploaded — ${failed.join('; ')}`, 'err', 10000);
    if (!ok) return;
    toast(`Uploaded ${ok} file${ok === 1 ? '' : 's'} — reading in the background`);
    await reloadCase(caseId);
    drive(caseId);
}
