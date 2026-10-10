// ============================================================
// Document reading pipeline — server-side, resumable, retried.
// State lives in case_documents.analysis (JSONB), so no extra tables:
//   queued → reading (locked) → done | error | unsupported
// Any caller (an open page, a cron ping) calls tick(); each tick reads as many
// documents as fit in its time budget. A closed tab only pauses the work.
// After documents finish, the case is rebuilt from them (facts first, summary when idle).
// ============================================================
const docs = require('../routes/documents');
const { extractDocumentText, UnsupportedFileError } = require('./extract-text');
const { generateJson } = require('./gemini');

const LOCK_MS = 4 * 60 * 1000;          // a crashed/timed-out run frees the document after this
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 1000;

function now() { return Date.now(); }

// What a tick should do with a document: 'read' (new / retry), 'upgrade' (re-extract from stored text), or null
function workFor(doc) {
    const a = doc.analysis;
    if (!a) return 'read';
    if (a.status === 'queued') return !a.nextTryAt || new Date(a.nextTryAt).getTime() <= now() ? 'read' : null;
    if (a.status === 'reading') return a.lockedUntil && new Date(a.lockedUntil).getTime() < now() ? 'read' : null;
    // Errors recorded before the pipeline existed get one fresh attempt
    if (a.status === 'error' && !a.attempts && a.error !== docs.MISSING_FILE_MESSAGE) return 'read';
    if (a.status === 'done' && !doc.textChars) return 'read';
    if (a.status === 'done' && (a.v || 1) < docs.ANALYSIS_VERSION) {
        if (a.upgradeLockedUntil && new Date(a.upgradeLockedUntil).getTime() > now()) return null;
        if (a.upgradeFailedAt) return null;
        return 'upgrade';
    }
    return null;
}

function isPending(doc) {
    const s = docs.docStatus(doc);
    return s === 'queued' || s === 'reading';
}

async function analyzeText(doc, text) {
    return generateJson([{ text: `${docs.ANALYSIS_PROMPT}\n\nFile name: ${doc.fileName}\n\nDOCUMENT TEXT:\n${text.slice(0, 1500000)}` }]);
}

// Re-extract a document already read with an older prompt, from its stored text. Keeps it usable meanwhile.
async function upgradeDoc(doc) {
    const prev = doc.analysis;
    const claimed = await docs.claimDoc(doc, { ...prev, upgradeLockedUntil: new Date(now() + LOCK_MS).toISOString() });
    if (!claimed) return { id: doc.id, result: 'skipped' };
    try {
        const text = (await docs.getDocTexts([doc])).get(doc.id) || '';
        const result = await analyzeText(doc, text);
        await docs.saveAnalysis(doc, { status: 'done', v: docs.ANALYSIS_VERSION, method: prev.method, attempts: prev.attempts || 1, ...result });
        return { id: doc.id, matterId: doc.matterId, result: 'upgraded' };
    } catch (e) {
        if (docs.isSchemaError(e.message)) throw e;
        const { upgradeLockedUntil, ...rest } = prev;
        await docs.saveAnalysis(doc, { ...rest, upgradeFailedAt: new Date().toISOString(), upgradeError: e.message });
        return { id: doc.id, matterId: doc.matterId, result: 'upgrade_failed', error: e.message };
    }
}

// Read one document: file → stored text → structured reading. Returns {id, matterId, result}
async function processDoc(doc, { deadline = now() + 50000 } = {}) {
    const prev = doc.analysis || {};
    const attempts = (prev.status === 'error' && !prev.attempts ? 0 : prev.attempts || 0) + 1;
    const claimed = await docs.claimDoc(doc, {
        status: 'reading', attempts, stage: doc.textChars ? 'analyze' : 'text',
        lockedUntil: new Date(now() + LOCK_MS).toISOString(), method: prev.method || null
    });
    if (!claimed) return { id: doc.id, matterId: doc.matterId, result: 'skipped' };

    try {
        let text = null;
        let method = prev.method || null;
        if (!doc.textChars) {
            const buffer = await docs.readDocBuffer(doc);
            let extracted;
            try {
                extracted = await extractDocumentText(buffer, doc.mimeType, doc.fileName);
            } catch (e) {
                if (!(e instanceof UnsupportedFileError)) throw e;
                await docs.saveAnalysis(doc, { status: 'unsupported', error: e.message, attempts });
                return { id: doc.id, matterId: doc.matterId, result: 'unsupported' };
            }
            text = extracted.text || '(no readable text found)';
            method = extracted.method;
            await docs.saveText(doc, text);
            // Long transcriptions: finish the reading in the next tick (progress isn't a failed attempt)
            if (now() > deadline - 20000) {
                await docs.saveAnalysis(doc, { status: 'queued', attempts: attempts - 1, method, stage: 'analyze' });
                return { id: doc.id, matterId: doc.matterId, result: 'partial' };
            }
        }
        if (text === null) text = (await docs.getDocTexts([doc])).get(doc.id) || '';
        const result = await analyzeText(doc, text);
        await docs.saveAnalysis(doc, { status: 'done', v: docs.ANALYSIS_VERSION, method, attempts, ...result });
        return { id: doc.id, matterId: doc.matterId, result: 'done' };
    } catch (e) {
        if (docs.isSchemaError(e.message)) throw e;
        const message = e.missing ? docs.MISSING_FILE_MESSAGE : friendly(e.message);
        console.error(`[Pipeline] "${doc.fileName}" attempt ${attempts} failed:`, e.message);
        const final = e.missing || attempts >= MAX_ATTEMPTS;
        const analysis = final
            ? { status: 'error', error: message.replace(/\s*It will be retried\.?$/, ''), attempts, method: doc.analysis && doc.analysis.method }
            : { status: 'queued', lastError: message, attempts, nextTryAt: new Date(now() + RETRY_BASE_MS * attempts).toISOString() };
        try { await docs.saveAnalysis(doc, analysis); } catch (_) {}
        return { id: doc.id, matterId: doc.matterId, result: final ? 'error' : 'retry', error: message };
    }
}

function friendly(msg) {
    const m = String(msg || '');
    if (/GOOGLE_API_KEY/.test(m)) return 'The AI service is not configured (GOOGLE_API_KEY missing).';
    if (/timeout|timed out|aborted/i.test(m)) return 'Reading timed out — very long or slow scan. It will be retried.';
    if (/429|quota|rate/i.test(m)) return 'The AI service is busy (rate limit). It will be retried.';
    if (/JSON/i.test(m)) return 'The AI returned an unreadable answer for this document.';
    if (/HTTP 5\d\d/.test(m)) return 'The AI service had a temporary error. It will be retried.';
    if (/password|encrypt/i.test(m)) return 'The PDF is password-protected.';
    return m.slice(0, 300);
}

// Docs with work to do, case-first ordering: new reads before upgrades, oldest first
async function loadWork(matterId) {
    let all;
    if (matterId) all = await docs.listDocs(matterId);
    else all = [...(await docs.listAllDocs()).values()].flat();
    const work = [];
    for (const d of all) {
        const kind = workFor(d);
        if (kind) work.push({ doc: d, kind });
    }
    work.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'read' ? -1 : 1) || String(a.doc.createdAt).localeCompare(String(b.doc.createdAt)));
    return { all, work };
}

// Summaries per case of where reading stands
function progressOf(all) {
    const byMatter = {};
    for (const d of all) {
        const p = byMatter[d.matterId] = byMatter[d.matterId] || { total: 0, done: 0, pending: 0, error: 0, unsupported: 0, upgrading: 0 };
        p.total++;
        const s = docs.docStatus(d);
        if (s === 'done') { p.done++; if ((d.analysis.v || 1) < docs.ANALYSIS_VERSION && !d.analysis.upgradeFailedAt) p.upgrading++; }
        else if (s === 'queued' || s === 'reading') p.pending++;
        else if (s === 'error') p.error++;
        else if (s === 'unsupported') p.unsupported++;
    }
    return byMatter;
}

// Rebuild cases whose documents changed. Facts always (cheap); the AI summary once reading is finished.
async function refreshCases(matterIds, { deadline }) {
    const { rebuildMatterFromDocuments, docsSignature, docIsDone } = require('../routes/matters');
    const { readMatter } = require('./matter-store');
    const rebuilt = [];
    for (const id of matterIds) {
        let matter;
        try { matter = await readMatter(id); } catch (_) { continue; }
        const list = await docs.listDocs(id);
        if (!list.length) continue;
        const sig = docsSignature(list);
        const doneSig = docsSignature(list.filter(docIsDone));
        // Documents still to read now (ones only waiting for a retry don't hold up the summary)
        const pending = list.some(d => workFor(d) === 'read' || (d.analysis && d.analysis.status === 'reading' && !workFor(d)));
        const upgrading = list.some(d => workFor(d) === 'upgrade');
        const needFacts = matter.factsSignature !== sig;
        // Summary when nothing is left to read (or once, early, so the case isn't blank while upgrades run)
        const needSummary = !pending && (matter.synthesisSignature !== doneSig) && (!upgrading || !matter.summary);
        if (!needFacts && !needSummary) continue;
        const canSummarize = needSummary && now() < deadline - 30000;
        try {
            await rebuildMatterFromDocuments(id, { synthesize: canSummarize });
            rebuilt.push({ id, summary: canSummarize });
        } catch (e) {
            console.error('[Pipeline] Rebuild failed for', id, e.message);
        }
    }
    return rebuilt;
}

// One unit of background work. Returns progress so callers know whether to call again.
async function tick({ matterId = null, budgetMs = 45000, concurrency = 3 } = {}) {
    const started = now();
    const deadline = started + budgetMs;
    const { work } = await loadWork(matterId);
    const results = [];
    let i = 0;
    async function worker() {
        // Start new work only while there's time to finish it
        while (i < work.length && now() < started + budgetMs * 0.45) {
            const { doc, kind } = work[i++];
            results.push(kind === 'upgrade' ? await upgradeDoc(doc) : await processDoc(doc, { deadline }));
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length || 1) }, worker));

    const { all } = await loadWork(matterId);
    const touched = new Set(results.map(r => r.matterId).filter(Boolean));
    if (matterId) touched.add(matterId);
    const rebuilt = await refreshCases([...touched], { deadline });
    const progress = progressOf(all);
    const remaining = all.filter(d => workFor(d) || isPending(d)).length;
    const waits = all.map(d => d.analysis && d.analysis.status === 'queued' && d.analysis.nextTryAt ? new Date(d.analysis.nextTryAt).getTime() - now() : null).filter(x => x !== null && x > 0);
    return { processed: results, rebuilt, progress, remaining, retryInMs: waits.length ? Math.min(...waits) : 0, ms: now() - started };
}

async function retryDoc(doc, { reextract = false, reread = false } = {}) {
    if (reread) await docs.saveText(doc, '');
    if (reextract && doc.textChars && !reread) {
        const prev = doc.analysis || {};
        await docs.saveAnalysis(doc, { ...prev, status: 'done', v: 1, upgradeFailedAt: null, upgradeLockedUntil: null });
    } else {
        await docs.saveAnalysis(doc, { status: 'queued', attempts: 0 });
    }
}

module.exports = { tick, processDoc, retryDoc, workFor, progressOf, loadWork };
