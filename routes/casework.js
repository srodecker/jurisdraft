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
const { listDocs, listAllDocs, saveGeneratedFile, getGeneratedFile, readGeneratedFile, deleteGeneratedFile, publicDoc, docStatus } = require('./documents');
const intel = require('../lib/case-intel');
const { candidatesFrom, LABELS } = require('../lib/fact-merge');
const services = require('../lib/services');
const formsV2 = require('../lib/forms/engine');
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
        unreadDocCount: docs.filter(d => { const st = docStatus(d); return st === 'queued' || st === 'reading'; }).length,
        failedDocCount: docs.filter(d => docStatus(d) === 'error').length,
        conflictCount: (m.factConflicts || []).length,
        nextStep: m.nextStep || '',
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
        documents: docs.map(d => {
            const done = d.analysis && d.analysis.status === 'done';
            return {
                ...publicDoc(d),
                summary: done ? d.analysis.summary || '' : '',
                keyFacts: done ? d.analysis.keyFacts || [] : [],
                extracted: done ? candidatesFrom(d).map(c => ({ key: c.key, label: LABELS[c.key] || c.key, value: c.value, quote: c.quote })) : [],
                filedWithCourt: !!(done && d.analysis.filedWithCourt),
                textChars: d.textChars || 0
            };
        })
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
    'statusText', 'summary', 'status', 'nextStep', 'reportNote', 'principal', 'interestAmount', 'interestRate',
    'payoffBalance', 'lastPaymentAmount', 'lastPaymentDate', 'contractDate', 'chargeOffDate', 'costs', 'attorneyFees'];

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
        // A fact the user set is no longer in dispute
        const set = new Set(changed.map(c => c.field));
        matter.factConflicts = (matter.factConflicts || []).filter(c => !set.has(c.field));
        const now = new Date().toISOString();
        matter.updatedAt = now;
        matter.events = matter.events || [];
        matter.events.push({
            id: crypto.randomUUID(), type: 'status_change', title: 'Case facts updated',
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

// Which engine fills a form: an explicit request wins, then FORMS_ENGINE for every form,
// then FORMS_V2_ON (comma-separated template files). Preview deployments default to the R4D on v2.
const V2_PREVIEW_DEFAULT = 'CIV-100 (R4D).pdf';
function useV2(file, requested) {
    if (requested) return requested === 'v2';
    if (process.env.FORMS_ENGINE) return process.env.FORMS_ENGINE === 'v2';
    const on = process.env.FORMS_V2_ON !== undefined ? process.env.FORMS_V2_ON : process.env.VERCEL_ENV === 'preview' ? V2_PREVIEW_DEFAULT : '';
    return on.split(',').map(s => s.trim()).includes(file);
}

async function generateForm(matter, formRef, values, session, by = 'user', opts = {}) {
    const form = intel.findForm(formRef);
    if (!form) throw Object.assign(new Error(`Unknown form "${formRef}". Available: ${intel.FORM_CATALOG.map(f => f.code + ' ' + f.title).join('; ')}`), { status: 400 });
    if (!services.fillPdfTemplate) throw new Error('Form engine not available');
    const data = intel.buildFormData(matter, values || {});
    const isDocx = form.file.endsWith('.docx');
    let buffer, emptyFields = [], filledCount = 0, used = data;
    // Forms v2 (standard field names + fact dictionary), only for templates that have been converted (templates/v2/)
    if (!isDocx && useV2(form.file, opts.engine) && await formsV2.hasV2Template(form.file)) {
        const r = await formsV2.fillTemplateV2(form.file, {
            matter, fd: intel.buildFormData(matter, {}), profile: session && session.profile, today: intel.todayLA(),
            overrides: values || {}, session, fillPdf: services.fillPdfTemplate
        });
        return saveRecord(matter, form, r.pdfBytes, 'application/pdf', {
            filledCount: r.filledCount, missing: r.missing, values: values || {}, engine: 'v2',
            filled: Object.fromEntries(Object.entries(r.values).filter(([, v]) => typeof v === 'string')),
            unknown: r.unknown
        }, by);
    }
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
    return saveRecord(matter, form, buffer, isDocx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf', {
        filledCount, missing: intel.importantMissing(emptyFields), values: values || {}, filled, engine: 'v1'
    }, by);
}

// Store a generated form on the case and log it
async function saveRecord(matter, form, buffer, contentType, extra, by) {
    const isDocx = contentType.includes('word');
    const now = new Date();
    const id = crypto.randomUUID();
    const ext = isDocx ? 'docx' : 'pdf';
    const fileName = `${form.code} ${form.title.split(' (')[0].split(' — ')[0]} - ${matter.debtorName || 'case'} - ${intel.isoDate(intel.todayLA())}.${ext}`.replace(/[\\/:*?"<>|]+/g, ' ');
    const storagePath = await saveGeneratedFile(matter.id, id, fileName, buffer, contentType);
    const record = {
        id, form: form.file, code: form.code, title: form.title, fileName, storagePath, contentType,
        ...extra,
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

// Filing packages: the forms that go together for one step, prepared in one click
const PACKAGES = [
    { id: 'complaint', title: 'New filing package', stage: 'intake', purpose: 'Summons, civil case cover sheet and (LA County) addendum for a new complaint.', forms: ['SUM-100.pdf', 'CM-010.pdf', 'LASC.pdf'] },
    { id: 'default', title: 'Request for entry of default', stage: 'default_window', purpose: 'Clerk\'s entry of default after the response time has run (CRC 3.110(g)).', forms: ['CIV-100 (R4D).pdf'] },
    { id: 'judgment', title: 'Default judgment package', stage: 'default_entered', purpose: 'Request for court judgment, dismissal of Does, and proof of service by mail (CRC 3.110(h), 3.1800).', forms: ['CIV-100.pdf', 'CIV-110 (Dismissal).pdf', 'POS_Def_Package.docx'] },
    { id: 'abstract', title: 'Abstract of judgment', stage: 'judgment', purpose: 'Abstract to record a judgment lien on real property.', forms: ['EJ-001.pdf'] }
];

router.get('/api/forms/packages', async (req, res) => {
    res.json(PACKAGES.map(p => ({ ...p, forms: p.forms.map(f => intel.findForm(f)).filter(Boolean).map(f => ({ file: f.file, code: f.code, title: f.title })) })));
});

router.post('/api/cases/:id/packages', async (req, res) => {
    try {
        const pkg = PACKAGES.find(p => p.id === req.body.package);
        if (!pkg) return res.status(400).json({ error: 'Unknown package' });
        const matter = await readMatter(req.params.id);
        const by = req.session ? req.session.username : 'user';
        const records = [];
        const errors = [];
        for (const file of pkg.forms) {
            try { records.push(await generateForm(matter, file, req.body.values || {}, req.session, by)); }
            catch (e) { errors.push(`${file}: ${e.message}`); }
        }
        await writeMatter(matter.id, matter);
        res.status(201).json({ package: pkg.id, title: pkg.title, records, errors });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// One PDF of several prepared forms (Word files are skipped), for printing or e-filing review
router.get('/api/cases/:id/forms-merged', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const ids = String(req.query.ids || '').split(',').filter(Boolean);
        const recs = ids.map(id => (matter.generatedForms || []).find(f => f.id === id)).filter(r => r && /pdf/.test(r.contentType || ''));
        if (!recs.length) return res.status(400).json({ error: 'No PDF forms to combine' });
        const out = await PDFDocument.create();
        for (const r of recs) {
            const src = await PDFDocument.load(await readGeneratedFile(r.storagePath), { ignoreEncryption: true });
            try { src.getForm().flatten(); } catch (_) {}
            const pages = await out.copyPages(src, src.getPageIndices());
            pages.forEach(p => out.addPage(p));
        }
        const name = `${matter.debtorName || 'case'} - forms ${intel.isoDate(intel.todayLA())}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${name}"`);
        res.send(Buffer.from(await out.save()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/cases/:id/forms', async (req, res) => {
    try {
        const matter = await readMatter(req.params.id);
        const record = await generateForm(matter, req.body.form, req.body.values, req.session, req.session ? req.session.username : 'user', { engine: req.body.engine });
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
Object.assign(module.exports, { PACKAGES, caseLabel, caseSummary, loadCaseView, resolveCase, updateFacts, addDeadline, addEvent, formVariables, generateForm, attentionItems, EDITABLE_FIELDS });
