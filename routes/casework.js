// ============================================================
// Case work: case overviews, corrections, deadlines, filled forms, Today dashboard.
// All routes are behind requireAuth (see server.js).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');

const { readMatter, writeMatter, listMatters } = require('../lib/matter-store');
const { listDocs, listAllDocs, saveGeneratedFile, getGeneratedFile, deleteGeneratedFile, publicDoc } = require('./documents');
const intel = require('../lib/case-intel');
const services = require('../lib/services');
const { applyFactOverrides, createMatterObject } = require('./matters');

const router = express.Router();
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// ---------- case views ----------
function caseLabel(m) {
    return `${m.debtorName || 'Unnamed'}${m.caseNumber ? ` (${m.caseNumber})` : ''}`;
}

function caseSummary(m, docs = [], today = intel.todayLA()) {
    const deadlines = intel.computeDeadlines(m, today);
    const open = deadlines.filter(d => d.status !== 'done');
    const readDocs = docs.filter(d => d.analysis && d.analysis.status === 'done');
    const lastDoc = docs.reduce((a, d) => (!a || d.createdAt > a ? d.createdAt : a), null);
    return {
        id: m.id,
        debtorName: m.debtorName || '',
        caseNumber: m.caseNumber || '',
        creditorName: m.creditorName || '',
        courtName: m.courtName || '',
        courtCounty: m.courtCounty || '',
        demandAmount: m.demandAmount || '',
        judgmentAmount: m.judgmentAmount || '',
        status: m.status || 'active',
        statusText: m.statusText || '',
        stage: intel.computeStage(m, today),
        nextDeadline: open[0] || null,
        overdueCount: open.filter(d => d.status === 'overdue').length,
        docCount: docs.length,
        unreadDocCount: docs.length - readDocs.length - docs.filter(d => d.analysis && d.analysis.status === 'unsupported').length,
        lastDocAt: lastDoc,
        updatedAt: m.updatedAt,
        fromDocuments: m.source === 'documents'
    };
}

async function loadCaseView(id) {
    const matter = await readMatter(id);
    const docs = await listDocs(id);
    const today = intel.todayLA();
    return {
        matter,
        summary: caseSummary(matter, docs, today),
        stage: intel.computeStage(matter, today),
        stages: intel.STAGES,
        deadlines: intel.computeDeadlines(matter, today),
        documents: docs.map(d => ({
            ...publicDoc(d),
            summary: d.analysis && d.analysis.status === 'done' ? d.analysis.summary || '' : '',
            keyFacts: d.analysis && d.analysis.status === 'done' ? d.analysis.keyFacts || [] : []
        }))
    };
}

// Find a case by id, case number or (part of) the debtor name
function resolveCase(matters, ref) {
    const q = String(ref || '').trim().toLowerCase();
    if (!q) return null;
    const byId = matters.find(m => m.id === ref);
    if (byId) return byId;
    const byNumber = matters.find(m => (m.caseNumber || '').toLowerCase() === q);
    if (byNumber) return byNumber;
    const tokens = q.split(/[^a-z0-9]+/).filter(t => t.length > 1);
    const scored = matters.map(m => {
        const hay = `${m.debtorName || ''} ${m.caseNumber || ''}`.toLowerCase();
        return { m, score: tokens.filter(t => hay.includes(t)).length };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].m : null;
}

// ---------- corrections (stored as overrides so a rebuild from documents keeps them) ----------
const EDITABLE_FIELDS = ['debtorName', 'debtorAddress', 'debtorCity', 'debtorState', 'debtorZip', 'caseNumber',
    'courtName', 'courtBranch', 'courtAddress', 'courtCounty', 'demandAmount', 'judgmentAmount', 'loanType',
    'accountNumber', 'creditorName', 'serviceType', 'servedBy', 'serviceAddress', 'defendantResponse',
    'statusText', 'summary', 'status'];

const DATE_KEYS = Object.keys(createMatterObject({}).dates);

function updateFacts(matter, updates, by = 'user') {
    matter.dates = matter.dates || {};
    const changed = [];
    const rejected = [];
    matter.factOverrides = matter.factOverrides || {};
    for (const [rawKey, rawValue] of Object.entries(updates || {})) {
        const key = String(rawKey).trim();
        let value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
        let ok = false;
        if (key.startsWith('dates.') && DATE_KEYS.includes(key.slice(6))) {
            if (key !== 'dates.serviceType' && value) {
                const d = intel.parseDate(value);
                if (!d) { rejected.push(`${key} (not a date: ${value})`); continue; }
                value = intel.isoDate(d);
            }
            ok = true;
        } else if (/^\[[A-Z0-9_]+\]$/.test(key)) ok = true;
        else if (EDITABLE_FIELDS.includes(key)) ok = true;
        if (!ok) { rejected.push(`${key} (unknown field)`); continue; }
        if (key === 'status' && value && !['active', 'closed'].includes(value)) { rejected.push('status (use active or closed)'); continue; }
        if (value === '') delete matter.factOverrides[key];
        else matter.factOverrides[key] = value;
        if (key.startsWith('dates.')) matter.dates[key.slice(6)] = value || null;
        else if (key.startsWith('[')) { matter.formData = matter.formData || {}; if (value) matter.formData[key] = value; else delete matter.formData[key]; }
        else matter[key] = value;
        changed.push({ field: key, value });
    }
    if (changed.length) {
        applyFactOverrides(matter);
        const now = new Date().toISOString();
        matter.updatedAt = now;
        matter.events = matter.events || [];
        matter.events.push({
            id: crypto.randomUUID(), type: 'note', title: 'Case facts updated',
            description: changed.map(c => `${c.field} → ${c.value || '(cleared)'}`).join('; '),
            date: now, addedBy: by, createdAt: now
        });
    }
    return { changed, rejected };
}

function addDeadline(matter, { title, date, notes }, by = 'user') {
    const d = intel.parseDate(date);
    if (!title || !d) throw Object.assign(new Error('A title and a valid date are required'), { status: 400 });
    const item = { id: crypto.randomUUID(), title: String(title).slice(0, 200), date: intel.isoDate(d), notes: notes ? String(notes).slice(0, 500) : '', done: false, createdBy: by, createdAt: new Date().toISOString() };
    matter.customDeadlines = matter.customDeadlines || [];
    matter.customDeadlines.push(item);
    matter.updatedAt = item.createdAt;
    return item;
}

function addEvent(matter, { type, title, date, description }, by = 'user') {
    const d = intel.parseDate(date) || intel.todayLA();
    const now = new Date().toISOString();
    const ev = { id: crypto.randomUUID(), type: type || 'note', title: String(title || 'Note').slice(0, 200), description: description ? String(description) : '', date: intel.isoDate(d), addedBy: by, createdAt: now };
    matter.events = matter.events || [];
    matter.events.push(ev);
    matter.updatedAt = now;
    return ev;
}

// ---------- forms ----------
const variableCache = new Map();
// Bracket variables a template uses (so the assistant knows what it can supply)
async function formVariables(form) {
    if (variableCache.has(form.file)) return variableCache.get(form.file);
    let vars = [];
    try {
        const buf = await fs.readFile(path.join(TEMPLATES_DIR, form.file));
        if (form.file.endsWith('.docx')) {
            const xml = new PizZip(buf).file('word/document.xml').asText().replace(/<[^>]+>/g, '');
            vars = xml.match(/\[[A-Z0-9_]+\]/g) || [];
        } else {
            const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
            vars = doc.getForm().getFields().map(f => f.getName().replace(/^.*\./, '')).filter(n => /^\[[A-Z0-9_]+\]$/.test(n));
        }
    } catch (e) { console.error('[Forms] Could not read template variables:', e.message); }
    vars = [...new Set(vars)].filter(v => !/PRINT|SAVE|CLEAR/.test(v));
    variableCache.set(form.file, vars);
    return vars;
}

async function generateForm(matter, formRef, values, session, by = 'user') {
    const form = intel.findForm(formRef);
    if (!form) throw Object.assign(new Error(`Unknown form "${formRef}". Available: ${intel.FORM_CATALOG.map(f => f.code + ' ' + f.title).join('; ')}`), { status: 400 });
    if (!services.fillPdfTemplate) throw new Error('Form engine not available');
    const data = intel.buildFormData(matter, values || {});
    const isDocx = form.file.endsWith('.docx');
    let buffer, emptyFields = [], filledCount = 0, used = data;
    if (isDocx) {
        const r = await services.fillDocxTemplate(form.file, data, session);
        buffer = r.buffer;
        filledCount = r.filledCount;
        used = r.processedData || data;
        const xml = new PizZip(buffer).file('word/document.xml').asText().replace(/<[^>]+>/g, '');
        emptyFields = [...new Set((xml.match(/\[[A-Z0-9_]+\]/g) || []))].filter(v => !['[PROPOSED]', '[X]'].includes(v));
    } else {
        const r = await services.fillPdfTemplate(form.file, data, session);
        buffer = r.pdfBytes;
        filledCount = r.filledCount;
        emptyFields = r.emptyFields;
        used = r.processedData || data;
    }
    // Snapshot of what went into the form, so the case shows it without opening the file
    const filled = {};
    for (const v of await formVariables(form)) {
        const val = used[v];
        if (val === undefined || val === null || val === '' || typeof val === 'boolean' || typeof val === 'object') continue;
        filled[v] = String(val).slice(0, 300);
    }
    const now = new Date();
    const id = crypto.randomUUID();
    const ext = isDocx ? 'docx' : 'pdf';
    const fileName = `${form.code} ${form.title.split(' (')[0].split(' — ')[0]} - ${matter.debtorName || 'case'} - ${intel.isoDate(intel.todayLA())}.${ext}`.replace(/[\\/:*?"<>|]+/g, ' ');
    const contentType = isDocx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
    const storagePath = await saveGeneratedFile(matter.id, id, fileName, buffer, contentType);
    const record = {
        id, form: form.file, code: form.code, title: form.title, fileName, storagePath, contentType,
        filledCount, missing: intel.importantMissing(emptyFields), values: values || {}, filled,
        createdBy: by, createdAt: now.toISOString()
    };
    matter.generatedForms = matter.generatedForms || [];
    matter.generatedForms.unshift(record);
    addEvent(matter, { type: 'filing', title: `Prepared ${form.code} — ${form.title}`, description: record.missing.length ? `Missing: ${record.missing.join(', ')}` : 'All key fields filled' }, by);
    return record;
}

// ---------- attention list ----------
function attentionItems(matters, today = intel.todayLA(), horizonDays = 14) {
    const items = [];
    for (const m of matters) {
        if (m.status === 'closed') continue;
        for (const d of intel.computeDeadlines(m, today)) {
            if (d.status === 'done' || d.kind === 'info') continue;
            if (d.status === 'upcoming' && d.daysAway > horizonDays) continue;
            items.push({ ...d, caseId: m.id, caseLabel: caseLabel(m), debtorName: m.debtorName || '' });
        }
    }
    const rank = { overdue: 0, soon: 1, upcoming: 2 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || a.date.localeCompare(b.date));
}

// ============================================================
// ROUTES
// ============================================================
router.get('/api/cases', async (req, res) => {
    try {
        const [matters, docsByMatter] = await Promise.all([listMatters(), listAllDocs().catch(() => new Map())]);
        const today = intel.todayLA();
        res.json(matters.filter(m => !m.isInbox).map(m => caseSummary(m, docsByMatter.get(m.id) || [], today)));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/cases', async (req, res) => {
    try {
        const name = String(req.body.debtorName || '').trim();
        if (!name) return res.status(400).json({ error: 'Debtor name is required' });
        const matter = createMatterObject({ debtorName: name, caseNumber: req.body.caseNumber || '' });
        matter.creditorName = '';
        matter.clientMatter = '';
        matter.attorney = '';
        matter.attorneyEmail = '';
        matter.secretary = '';
        matter.source = 'documents';
        addEvent(matter, { type: 'status_change', title: 'Case opened', description: `New case for ${name}` }, req.session ? req.session.username : 'user');
        await writeMatter(matter.id, matter);
        res.status(201).json(matter);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/cases/:id', async (req, res) => {
    try {
        res.json(await loadCaseView(req.params.id));
    } catch (err) {
        res.status(404).json({ error: 'Case not found' });
    }
});

router.patch('/api/cases/:id/facts', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const result = updateFacts(matter, req.body.updates || {}, req.session ? req.session.username : 'user');
        if (result.changed.length) await writeMatter(matter.id, matter);
        res.json({ ...result, ...(await loadCaseView(matter.id)) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/api/cases/:id/deadlines', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const item = addDeadline(matter, req.body, req.session ? req.session.username : 'user');
        await writeMatter(matter.id, matter);
        res.status(201).json(item);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.patch('/api/cases/:id/deadlines/:deadlineId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const item = (matter.customDeadlines || []).find(d => d.id === req.params.deadlineId);
        if (!item) return res.status(404).json({ error: 'Deadline not found' });
        if (req.body.done !== undefined) item.done = !!req.body.done;
        await writeMatter(matter.id, matter);
        res.json(item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/cases/:id/deadlines/:deadlineId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        matter.customDeadlines = (matter.customDeadlines || []).filter(d => d.id !== req.params.deadlineId);
        await writeMatter(matter.id, matter);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/forms', async (req, res) => {
    res.json(intel.FORM_CATALOG);
});

router.post('/api/cases/:id/forms', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const record = await generateForm(matter, req.body.form, req.body.values, req.session, req.session ? req.session.username : 'user');
        await writeMatter(matter.id, matter);
        res.status(201).json(record);
    } catch (err) {
        console.error('[Forms] Generate failed:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.get('/api/cases/:id/forms/:formId/download', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const rec = (matter.generatedForms || []).find(f => f.id === req.params.formId);
        if (!rec) return res.status(404).json({ error: 'Form not found' });
        const file = await getGeneratedFile(rec.storagePath, rec.fileName, { inline: req.query.inline === '1' });
        if (file.url) return res.json({ url: file.url, fileName: rec.fileName });
        res.set('Content-Type', rec.contentType || 'application/octet-stream');
        if (req.query.inline === '1') res.set('Content-Disposition', `inline; filename="${rec.fileName.replace(/"/g, '')}"`);
        else res.attachment(rec.fileName);
        res.send(file.buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/cases/:id/forms/:formId', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const rec = (matter.generatedForms || []).find(f => f.id === req.params.formId);
        if (!rec) return res.status(404).json({ error: 'Form not found' });
        await deleteGeneratedFile(rec.storagePath);
        matter.generatedForms = matter.generatedForms.filter(f => f.id !== rec.id);
        await writeMatter(matter.id, matter);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/dashboard/today', async (req, res) => {
    try {
        const [allMatters, docsByMatter] = await Promise.all([listMatters(), listAllDocs().catch(() => new Map())]);
        const matters = allMatters.filter(m => !m.isInbox);
        const today = intel.todayLA();
        const cases = matters.map(m => caseSummary(m, docsByMatter.get(m.id) || [], today));
        const pipeline = {};
        for (const c of cases) pipeline[c.stage.key] = (pipeline[c.stage.key] || 0) + 1;
        const hearings = [];
        for (const m of matters) {
            for (const h of m.hearings || []) {
                const d = intel.parseDate(h.date);
                if (!d || /vacat/i.test(h.status || '')) continue;
                const days = Math.round((d - today) / 86400000);
                if (days >= 0 && days <= 60) hearings.push({ ...h, daysAway: days, caseId: m.id, caseLabel: caseLabel(m) });
            }
        }
        hearings.sort((a, b) => a.date.localeCompare(b.date));
        const recentDocs = [];
        for (const m of matters) {
            for (const d of docsByMatter.get(m.id) || []) {
                const p = publicDoc(d);
                recentDocs.push({ caseId: m.id, caseLabel: caseLabel(m), id: d.id, fileName: d.fileName, documentType: p.documentType, analysisStatus: p.analysisStatus, createdAt: d.createdAt });
            }
        }
        recentDocs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        res.json({
            today: intel.isoDate(today),
            cases,
            attention: attentionItems(matters, today),
            hearings: hearings.slice(0, 20),
            pipeline,
            stages: intel.STAGES,
            recentDocs: recentDocs.slice(0, 12)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
Object.assign(module.exports, { caseLabel, caseSummary, loadCaseView, resolveCase, updateFacts, addDeadline, addEvent, formVariables, generateForm, attentionItems, EDITABLE_FIELDS });
