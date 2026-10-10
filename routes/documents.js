// ============================================================
// CASE DOCUMENTS — per-matter file storage
// Supabase mode: files in a private Storage bucket, metadata in `case_documents`.
//   Browser uploads go straight to Storage via signed upload URLs, so file size
//   is not capped by the serverless request body limit.
// File mode (no Supabase): files and an index.json per matter on local disk.
// ============================================================
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { generateJson, uploadToFileApi, geminiMimeFor, geminiUploadBody } = require('../lib/gemini');
const { extractDocumentText, UnsupportedFileError } = require('../lib/extract-text');

const router = express.Router();

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 20 } });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET || 'case-documents';
const TABLE = 'case_documents';

let supabase = null;
if (useSupabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const MATTERS_DIR = isServerless ? path.join('/tmp', 'matters') : path.join(__dirname, '..', 'matters');
const DOCS_DIR = isServerless ? path.join('/tmp', 'case-documents') : path.join(__dirname, '..', 'case-documents');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// HELPERS
// ============================================================

// Display name: strip path parts and control chars, cap length
function cleanFileName(name) {
    const base = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim();
    return (base || 'document').slice(0, 200);
}

// Storage key segment: ASCII-safe version of the display name
function storageSafeName(name) {
    const safe = cleanFileName(name).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
    return (safe || 'document').slice(0, 120);
}

function rowToDoc(row) {
    return {
        id: row.id,
        matterId: row.matter_id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        size: Number(row.size_bytes) || 0,
        uploadedBy: row.uploaded_by,
        createdAt: row.created_at,
        analysis: row.analysis || null,
        analyzedAt: row.analyzed_at || null,
        geminiFileUri: row.gemini_file_uri || null,
        geminiFileExpiresAt: row.gemini_file_expires_at || null,
        textChars: row.text_chars || null
    };
}

function docToRow(doc) {
    return {
        id: doc.id,
        matter_id: doc.matterId,
        file_name: doc.fileName,
        storage_path: doc.storagePath,
        mime_type: doc.mimeType,
        size_bytes: doc.size,
        uploaded_by: doc.uploadedBy,
        created_at: doc.createdAt
    };
}

// Client-facing shape: no storage path, analysis reduced to status + type
function publicDoc(doc) {
    const { storagePath, analysis, geminiFileUri, geminiFileExpiresAt, fullText, ...rest } = doc;
    let status = analysis ? analysis.status : 'none';
    // Read before full text was stored (or summary still pending) → needs reading
    if (status === 'done' && !doc.textChars) status = 'none';
    return {
        ...rest,
        analysisStatus: status,
        analysisError: analysis && analysis.status !== 'done' ? analysis.error || null : null,
        documentType: analysis && analysis.documentType ? analysis.documentType : null,
        documentDate: analysis && analysis.documentDate ? analysis.documentDate : null
    };
}

function friendlyDbError(error) {
    const msg = error && error.message ? error.message : String(error);
    if (/relation .*case_documents.* does not exist|Could not find the table/i.test(msg)) {
        return 'Documents table missing. Run supabase-schema.sql in the Supabase SQL Editor.';
    }
    if (/analy[sz]ed?_at|column .*analysis|gemini_file|full_text|text_chars/i.test(msg)) {
        return 'Documents table needs the AI columns. Run in the Supabase SQL Editor: ALTER TABLE case_documents ADD COLUMN IF NOT EXISTS analysis JSONB, ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS gemini_file_uri TEXT, ADD COLUMN IF NOT EXISTS gemini_file_expires_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS full_text TEXT, ADD COLUMN IF NOT EXISTS text_chars INTEGER;';
    }
    return msg;
}

let bucketReady = false;
async function ensureBucket() {
    if (bucketReady) return;
    const { error } = await supabase.storage.getBucket(BUCKET);
    if (error) {
        const { error: createErr } = await supabase.storage.createBucket(BUCKET, { public: false });
        if (createErr && !/already exists/i.test(createErr.message)) {
            throw new Error(`Storage bucket "${BUCKET}" unavailable: ${createErr.message}`);
        }
    }
    bucketReady = true;
}

async function matterExists(id) {
    if (!UUID_RE.test(id)) return false;
    if (useSupabase) {
        const { data, error } = await supabase.from('matters').select('id').eq('id', id).maybeSingle();
        return !error && !!data;
    }
    try {
        await fs.access(path.join(MATTERS_DIR, `${id}.json`));
        return true;
    } catch (_) {
        return false;
    }
}

// --- File-mode index helpers ---
function matterDocsDir(matterId) { return path.join(DOCS_DIR, matterId); }
function indexPath(matterId) { return path.join(matterDocsDir(matterId), 'index.json'); }

async function readIndex(matterId) {
    try {
        return JSON.parse(await fs.readFile(indexPath(matterId), 'utf-8'));
    } catch (_) {
        return [];
    }
}

async function writeIndex(matterId, docs) {
    await fs.mkdir(matterDocsDir(matterId), { recursive: true });
    await fs.writeFile(indexPath(matterId), JSON.stringify(docs, null, 2));
}

// Read-modify-write of a matter's index, serialized so parallel updates don't overwrite each other
const indexLocks = new Map();
function updateIndex(matterId, mutate) {
    const prev = indexLocks.get(matterId) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const docs = await readIndex(matterId);
        mutate(docs);
        await writeIndex(matterId, docs);
    });
    indexLocks.set(matterId, run);
    return run;
}

// --- Backend-agnostic data access ---
// Every column except full_text (which can be megabytes); fetched separately with getDocTexts
const DOC_COLUMNS = 'id, matter_id, file_name, storage_path, mime_type, size_bytes, uploaded_by, created_at, analysis, analyzed_at, gemini_file_uri, gemini_file_expires_at, text_chars';
let textColumnsMissing = false;
async function selectDocRows(build) {
    if (!textColumnsMissing) {
        const { data, error } = await build(DOC_COLUMNS);
        if (!error) return data;
        if (!/text_chars|gemini_file|analy/i.test(error.message)) throw new Error(friendlyDbError(error));
        console.error('[Documents] AI columns missing — run the ALTER TABLE in supabase-schema.sql');
        textColumnsMissing = true;
    }
    const { data, error } = await build('*');
    if (error) throw new Error(friendlyDbError(error));
    const strip = r => { if (!r) return r; const { full_text, ...rest } = r; return rest; };
    return Array.isArray(data) ? data.map(strip) : strip(data);
}

async function listDocs(matterId) {
    if (useSupabase) {
        const rows = await selectDocRows(cols => supabase.from(TABLE).select(cols).eq('matter_id', matterId).order('created_at', { ascending: false }));
        return rows.map(r => ({ ...rowToDoc(r), storagePath: r.storage_path }));
    }
    const docs = await readIndex(matterId);
    return docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getDoc(matterId, docId) {
    if (!UUID_RE.test(docId)) return null;
    if (useSupabase) {
        const data = await selectDocRows(cols => supabase.from(TABLE).select(cols).eq('id', docId).eq('matter_id', matterId).maybeSingle());
        return data ? { ...rowToDoc(data), storagePath: data.storage_path } : null;
    }
    return (await readIndex(matterId)).find(d => d.id === docId) || null;
}

async function insertDoc(doc) {
    if (useSupabase) {
        const { error } = await supabase.from(TABLE).insert(docToRow(doc));
        if (error) throw new Error(friendlyDbError(error));
        return;
    }
    const docs = await readIndex(doc.matterId);
    docs.push(doc);
    await writeIndex(doc.matterId, docs);
}

async function removeDoc(doc) {
    if (useSupabase) {
        const { data: exists } = await supabase.storage.from(BUCKET).exists(doc.storagePath);
        if (!exists) { try { await relinkIfMoved(doc); } catch (_) {} }
        const { error: rmErr } = await supabase.storage.from(BUCKET).remove([doc.storagePath]);
        if (rmErr) console.error('[Documents] Storage remove failed:', rmErr.message);
        const { error } = await supabase.from(TABLE).delete().eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
        return;
    }
    await fs.rm(path.join(DOCS_DIR, doc.storagePath), { force: true });
    await fs.rm(path.dirname(path.join(DOCS_DIR, doc.storagePath)), { recursive: true, force: true });
    const docs = (await readIndex(doc.matterId)).filter(d => d.id !== doc.id);
    await writeIndex(doc.matterId, docs);
}

// ---- Moved-file recovery ----
// Files are stored at <matterId>/<docId>/<name>. If someone moves the folders in the Supabase
// dashboard (e.g. into "Erick Acevedo Files/"), the <docId>/<name> part is kept, so the file can be
// found again under any top-level folder.
let rootFoldersCache = { at: 0, folders: null };
async function listRootFolders() {
    if (rootFoldersCache.folders && Date.now() - rootFoldersCache.at < 60000) return rootFoldersCache.folders;
    const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
    if (error) throw new Error(error.message);
    const folders = (data || []).filter(o => !o.id).map(o => o.name);
    rootFoldersCache = { at: Date.now(), folders };
    return folders;
}

async function locateMovedFile(doc) {
    const original = String(doc.storagePath || '').split('/').pop();
    const pick = names => names.find(n => n === original) || names.find(n => n !== '.emptyFolderPlaceholder');
    if (useSupabase) {
        const candidates = [doc.id, ...(await listRootFolders()).map(f => `${f}/${doc.id}`)];
        for (const folder of candidates) {
            const { data } = await supabase.storage.from(BUCKET).list(folder, { limit: 20 });
            const name = pick((data || []).filter(o => o.id).map(o => o.name));
            if (name) return `${folder}/${name}`;
        }
        return null;
    }
    let dirs = [];
    try { dirs = await fs.readdir(DOCS_DIR); } catch (_) { return null; }
    for (const dir of dirs) {
        try {
            const name = pick(await fs.readdir(path.join(DOCS_DIR, dir, doc.id)));
            if (name) return `${dir}/${doc.id}/${name}`;
        } catch (_) {}
    }
    return null;
}

async function saveStoragePath(doc, storagePath) {
    const clearMissing = doc.analysis && doc.analysis.error === MISSING_FILE_MESSAGE;
    if (useSupabase) {
        const update = { storage_path: storagePath };
        if (clearMissing) update.analysis = null;
        const { error } = await supabase.from(TABLE).update(update).eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
    } else {
        await updateIndex(doc.matterId, docs => {
            const target = docs.find(d => d.id === doc.id);
            if (target) {
                target.storagePath = storagePath;
                if (clearMissing) target.analysis = null;
            }
        });
    }
    doc.storagePath = storagePath;
    if (clearMissing) doc.analysis = null;
}

// If the file isn't at its recorded path, look for it and repair the record. Returns true if fixed.
async function relinkIfMoved(doc) {
    const found = await locateMovedFile(doc);
    if (!found || found === doc.storagePath) return false;
    console.log(`[Documents] "${doc.fileName}" was moved in storage: ${doc.storagePath} → ${found}`);
    await saveStoragePath(doc, found);
    return true;
}

async function readDocBuffer(doc) {
    try {
        return await readDocBufferAt(doc);
    } catch (e) {
        if (e.missing && await relinkIfMoved(doc)) return readDocBufferAt(doc);
        throw e;
    }
}

async function readDocBufferAt(doc) {
    if (useSupabase) {
        const { data, error } = await supabase.storage.from(BUCKET).download(doc.storagePath);
        if (error) {
            const err = new Error(`Could not read "${doc.fileName}" from storage: ${error.message}`);
            err.missing = /not found/i.test(error.message);
            throw err;
        }
        return Buffer.from(await data.arrayBuffer());
    }
    try {
        return await fs.readFile(path.join(DOCS_DIR, doc.storagePath));
    } catch (e) {
        const err = new Error(`Could not read "${doc.fileName}" from storage: ${e.code === 'ENOENT' ? 'Object not found' : e.message}`);
        err.missing = e.code === 'ENOENT';
        throw err;
    }
}

const MISSING_FILE_MESSAGE = 'The stored file is missing — remove this document and upload it again.';

async function saveAnalysis(doc, analysis) {
    const analyzedAt = new Date().toISOString();
    if (useSupabase) {
        const { error } = await supabase.from(TABLE).update({ analysis, analyzed_at: analyzedAt }).eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
        return;
    }
    await updateIndex(doc.matterId, docs => {
        const target = docs.find(d => d.id === doc.id);
        if (target) {
            target.analysis = analysis;
            target.analyzedAt = analyzedAt;
        }
    });
}

// ---- Gemini file cache: the real document is uploaded to Google once and reused for 48 h ----
const REUSE_MARGIN_MS = 60 * 60 * 1000; // re-upload when less than 1 h of validity is left

async function saveGeminiFile(doc, uri, expiresAt) {
    if (useSupabase) {
        const { error } = await supabase.from(TABLE).update({ gemini_file_uri: uri, gemini_file_expires_at: expiresAt }).eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
        return;
    }
    await updateIndex(doc.matterId, docs => {
        const target = docs.find(d => d.id === doc.id);
        if (target) {
            target.geminiFileUri = uri;
            target.geminiFileExpiresAt = expiresAt;
        }
    });
}

// Returns the Gemini request part for a document ({file_data}), uploading it if needed.
// Returns null when the file type can't be read by Gemini.
async function ensureGeminiFile(doc, { buffer = null, force = false } = {}) {
    const mime = geminiMimeFor(doc.mimeType, doc.fileName);
    if (!mime) return null;
    const valid = doc.geminiFileUri && doc.geminiFileExpiresAt &&
        new Date(doc.geminiFileExpiresAt).getTime() - Date.now() > REUSE_MARGIN_MS;
    if (valid && !force) return { file_data: { mime_type: mime, file_uri: doc.geminiFileUri } };

    const raw = buffer || await readDocBuffer(doc);
    const { part, expiresAt } = await uploadToFileApi(geminiUploadBody(raw, doc.mimeType, doc.fileName), mime, doc.fileName);
    const uri = part.file_data.file_uri;
    // Caching is an optimisation — a failed save (e.g. columns not migrated yet) must not block reading
    try { await saveGeminiFile(doc, uri, expiresAt); } catch (e) { console.error('[Documents] Could not cache Gemini file reference:', e.message); }
    doc.geminiFileUri = uri;
    doc.geminiFileExpiresAt = expiresAt;
    return { file_data: { mime_type: mime, file_uri: uri } };
}

// Gemini parts for every document of the given docs list: a label before each file.
// Runs 6 uploads at a time. Returns { parts, included, skipped }.
// A file that fails (e.g. missing from storage) is skipped and listed, not fatal —
// unless every file fails, which points to a service problem.
async function buildFileParts(docs, { force = false, labelPrefix = '' } = {}) {
    const results = new Array(docs.length);
    const errors = new Array(docs.length);
    let next = 0;
    async function worker() {
        while (next < docs.length) {
            const i = next++;
            try {
                results[i] = await ensureGeminiFile(docs[i], { force });
            } catch (e) {
                errors[i] = e;
                console.error(`[Documents] Skipping "${docs[i].fileName}":`, e.message);
                // Flag missing files on the Documents page
                if (e.missing) { try { await saveAnalysis(docs[i], { status: 'error', error: MISSING_FILE_MESSAGE }); } catch (_) {} }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(6, docs.length) }, worker));
    const failed = errors.filter(Boolean);
    const readable = results.filter(Boolean).length;
    if (failed.length && !readable) throw new Error(`None of the case documents could be read: ${failed[0].message}`);

    const parts = [];
    const included = [];
    const skipped = [];
    docs.forEach((d, i) => {
        if (errors[i]) { skipped.push(`${d.fileName} (${errors[i].missing ? 'file missing from storage' : String(errors[i].message).slice(0, 150)})`); return; }
        if (!results[i]) { skipped.push(`${d.fileName} (file type not readable)`); return; }
        included.push(d.fileName);
        parts.push({ text: `=== ${labelPrefix}Document: ${d.fileName} (uploaded ${String(d.createdAt || '').slice(0, 10)}) ===` });
        parts.push(results[i]);
    });
    if (skipped.length) parts.push({ text: `${labelPrefix}Documents that could NOT be read for this answer: ${skipped.join('; ')}` });
    return { parts, included, skipped };
}


// ---- Stored full text: each document is read once; chat uses the saved text ----
async function saveText(doc, text) {
    if (useSupabase) {
        const { error } = await supabase.from(TABLE).update({ full_text: text, text_chars: text.length }).eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
    } else {
        await updateIndex(doc.matterId, docs => {
            const target = docs.find(d => d.id === doc.id);
            if (target) { target.fullText = text; target.textChars = text.length; }
        });
    }
    doc.textChars = text.length;
}

// Map(docId → full text) for documents that have stored text
async function getDocTexts(docs) {
    const out = new Map();
    const withText = docs.filter(d => d.textChars);
    if (!useSupabase) {
        withText.forEach(d => out.set(d.id, d.fullText || ''));
        return out;
    }
    for (let i = 0; i < withText.length; i += 50) {
        const ids = withText.slice(i, i + 50).map(d => d.id);
        const { data, error } = await supabase.from(TABLE).select('id, full_text').in('id', ids);
        if (error) throw new Error(friendlyDbError(error));
        (data || []).forEach(r => out.set(r.id, r.full_text || ''));
    }
    return out;
}

// Chat context from stored text. Returns:
//   text        — labelled full text of every read document (oldest first), within maxChars;
//                 documents over the budget fall back to their summary
//   unread      — documents not read yet (the caller attaches their files instead)
//   unsupported — file names that can't be read
async function buildTextContext(docs, { labelPrefix = '', maxChars = 2400000 } = {}) {
    const ordered = [...docs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const isUnsupported = d => d.analysis && d.analysis.status === 'unsupported';
    const texts = await getDocTexts(ordered);
    const blocks = [];
    const summaries = [];
    let used = 0;
    for (const d of ordered.filter(x => x.textChars)) {
        const block = `=== ${labelPrefix}Document: ${d.fileName} (uploaded ${String(d.createdAt || '').slice(0, 10)}) ===\n${texts.get(d.id) || ''}`;
        if (used + block.length <= maxChars) {
            blocks.push(block);
            used += block.length;
        } else if (d.analysis && d.analysis.summary) {
            summaries.push(`=== ${labelPrefix}Document (summary only — too long to include in full): ${d.fileName} ===\n${d.analysis.summary}`);
        }
    }
    return {
        text: [...blocks, ...summaries].join('\n\n'),
        included: blocks.length,
        unread: ordered.filter(d => !d.textChars && !isUnsupported(d)),
        unsupported: ordered.filter(isUnsupported).map(d => d.fileName)
    };
}

// All documents for a matter with their stored AI analysis (server-side use only)
async function listDocAnalyses(matterId) {
    const docs = await listDocs(matterId);
    return docs.map(d => ({ id: d.id, matterId: d.matterId, fileName: d.fileName, createdAt: d.createdAt, analysis: d.analysis || null }));
}

// Every document of every matter (full internal records) → Map(matterId → docs[])
async function listAllDocs() {
    const byMatter = new Map();
    const add = d => {
        if (!byMatter.has(d.matterId)) byMatter.set(d.matterId, []);
        byMatter.get(d.matterId).push(d);
    };
    if (useSupabase) {
        const rows = await selectDocRows(cols => supabase.from(TABLE).select(cols).order('created_at', { ascending: true }));
        rows.forEach(r => add({ ...rowToDoc(r), storagePath: r.storage_path }));
        return byMatter;
    }
    let dirs = [];
    try { dirs = await fs.readdir(DOCS_DIR); } catch (_) {}
    for (const dir of dirs) {
        if (UUID_RE.test(dir)) (await readIndex(dir)).forEach(add);
    }
    return byMatter;
}

const ANALYSIS_PROMPT = `You are a legal document analyst for a California debt collection law firm (client: Kinecta Federal Credit Union).
Read the case document below completely and return ONE JSON object describing it. Use only information actually in the document — never guess. Omit fields you cannot find.

{
  "documentType": "short type, e.g. Complaint, Summons, Proof of Service, Demand Letter / DVN, Default Judgment, Minute Order, Notice of Hearing, Answer, Correspondence, Account Statement, Loan Agreement, Writ, Abstract of Judgment",
  "documentDate": "YYYY-MM-DD — the date the document was signed, filed or issued",
  "summary": "detailed factual summary (300-600 words): who, what, when, amounts, court, case number, deadlines, rulings, and anything a paralegal would need to know",
  "keyFacts": ["short factual statements, each self-contained, e.g. 'Complaint filed 2024-03-12 in LASC, case 24STLC01234'"],
  "fields": {
    "debtorName": "full name of debtor/defendant/borrower",
    "debtorAddress": "street address", "debtorCity": "city", "debtorState": "2-letter state", "debtorZip": "zip",
    "caseNumber": "court case number", "courtName": "court name", "courtCounty": "county",
    "demandAmount": "amount owed/demanded, number only", "judgmentAmount": "judgment amount, number only",
    "loanType": "type of loan", "accountNumber": "account or loan number", "creditorName": "creditor/plaintiff"
  },
  "dates": {
    "dvnSent": "YYYY-MM-DD", "responseDue": "YYYY-MM-DD", "complaintFiled": "YYYY-MM-DD", "served": "YYYY-MM-DD",
    "serviceType": "personal | substituted", "answerDue": "YYYY-MM-DD", "answerReceived": "YYYY-MM-DD",
    "defaultEntered": "YYYY-MM-DD", "judgmentEntered": "YYYY-MM-DD", "abstractFiled": "YYYY-MM-DD",
    "abstractRecorded": "YYYY-MM-DD", "writIssued": "YYYY-MM-DD", "closed": "YYYY-MM-DD"
  },
  "events": [{ "type": "filing|hearing|service|correspondence|minute_order|court_order|payment|note", "title": "brief title", "date": "YYYY-MM-DD", "description": "details" }],
  "hearings": [{ "type": "e.g. Case Management Conference, Trial, OSC", "date": "YYYY-MM-DD", "time": "e.g. 8:30 AM", "department": "e.g. Dept. 25", "location": "courthouse", "status": "scheduled | continued | vacated | held" }]
}

Rules: dates in YYYY-MM-DD; amounts as plain numbers (no $ or commas); include every date, deadline and event mentioned.`;

// Remove every stored file + metadata row for a matter (called when a matter is deleted).
// Pass no matterId to remove all documents for all matters.
async function deleteAllDocuments(matterId) {
    if (useSupabase) {
        let query = supabase.from(TABLE).select('id, storage_path');
        if (matterId) query = query.eq('matter_id', matterId);
        const { data, error } = await query;
        if (error) {
            // Table not created yet → nothing to clean up
            console.error('[Documents] Cleanup skipped:', error.message);
            return;
        }
        const paths = (data || []).map(r => r.storage_path);
        for (let i = 0; i < paths.length; i += 100) {
            const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
            if (rmErr) console.error('[Documents] Storage cleanup failed:', rmErr.message);
        }
        let del = supabase.from(TABLE).delete();
        del = matterId ? del.eq('matter_id', matterId) : del.neq('id', '00000000-0000-0000-0000-000000000000');
        const { error: delErr } = await del;
        if (delErr) console.error('[Documents] Metadata cleanup failed:', delErr.message);
        return;
    }
    await fs.rm(matterId ? matterDocsDir(matterId) : DOCS_DIR, { recursive: true, force: true });
}

// ============================================================
// ROUTES — all under /api/matters (protected by requireAuth in server.js)
// ============================================================

// Validate matter on every document route
router.use('/api/matters/:id/documents', async (req, res, next) => {
    try {
        if (!(await matterExists(req.params.id))) return res.status(404).json({ error: 'Case not found' });
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List documents for a case
router.get('/api/matters/:id/documents', async (req, res) => {
    try {
        const docs = await listDocs(req.params.id);
        res.json({ documents: docs.map(publicDoc), storage: useSupabase ? 'supabase' : 'file' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 1 (Supabase): get a signed URL so the browser can upload directly to Storage.
// In file mode returns { direct: false } and the client posts multipart to /documents instead.
router.post('/api/matters/:id/documents/init', async (req, res) => {
    if (!useSupabase) return res.json({ direct: false });
    try {
        const fileName = cleanFileName(req.body.fileName);
        const size = Number(req.body.size) || 0;
        if (size <= 0) return res.status(400).json({ error: `"${fileName}" is empty` });
        if (size > MAX_FILE_BYTES) return res.status(413).json({ error: `"${fileName}" exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit` });

        await ensureBucket();
        const docId = crypto.randomUUID();
        const storagePath = `${req.params.id}/${docId}/${storageSafeName(fileName)}`;
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
        if (error) throw new Error(error.message);
        res.json({ direct: true, docId, signedUrl: data.signedUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 2 (Supabase): confirm the object landed in Storage, then record metadata.
// Size/type come from Storage, not the client.
router.post('/api/matters/:id/documents/complete', async (req, res) => {
    if (!useSupabase) return res.status(400).json({ error: 'Direct upload not enabled' });
    try {
        const matterId = req.params.id;
        const docId = String(req.body.docId || '');
        if (!UUID_RE.test(docId)) return res.status(400).json({ error: 'Invalid document id' });

        const folder = `${matterId}/${docId}`;
        const { data: objects, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 2 });
        if (error) throw new Error(error.message);
        const obj = (objects || []).find(o => o.id);
        if (!obj) return res.status(400).json({ error: 'Upload not found in storage' });

        const doc = {
            id: docId,
            matterId,
            fileName: cleanFileName(req.body.fileName || obj.name),
            storagePath: `${folder}/${obj.name}`,
            mimeType: (obj.metadata && obj.metadata.mimetype) || req.body.mimeType || 'application/octet-stream',
            size: (obj.metadata && obj.metadata.size) || 0,
            uploadedBy: req.session ? req.session.username : null,
            createdAt: new Date().toISOString()
        };
        try {
            await insertDoc(doc);
        } catch (insertErr) {
            // Don't leave an orphaned object behind
            await supabase.storage.from(BUCKET).remove([doc.storagePath]);
            throw insertErr;
        }
        res.status(201).json(publicDoc(doc));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Multipart upload through the server (file mode, or fallback)
router.post('/api/matters/:id/documents', (req, res, next) => {
    upload.array('files')(req, res, err => {
        if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit` : err.message });
        next();
    });
}, async (req, res) => {
    try {
        const matterId = req.params.id;
        const files = req.files || [];
        if (files.length === 0) return res.status(400).json({ error: 'No files received' });
        if (useSupabase) await ensureBucket();

        const saved = [];
        for (const f of files) {
            // multer decodes multipart filenames as latin1
            const fileName = cleanFileName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
            const docId = crypto.randomUUID();
            const storagePath = `${matterId}/${docId}/${storageSafeName(fileName)}`;
            const mimeType = f.mimetype || 'application/octet-stream';
            if (useSupabase) {
                const { error } = await supabase.storage.from(BUCKET).upload(storagePath, f.buffer, { contentType: mimeType, upsert: false });
                if (error) throw new Error(`Upload failed for "${fileName}": ${error.message}`);
            } else {
                const dest = path.join(DOCS_DIR, storagePath);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, f.buffer);
            }
            const doc = {
                id: docId,
                matterId,
                fileName,
                storagePath,
                mimeType,
                size: f.size,
                uploadedBy: req.session ? req.session.username : null,
                createdAt: new Date().toISOString()
            };
            await insertDoc(doc);
            saved.push(publicDoc(doc));
        }
        res.status(201).json({ documents: saved });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download: Supabase → short-lived signed URL (JSON); file mode → stream the file
router.get('/api/matters/:id/documents/:docId/download', async (req, res) => {
    try {
        const doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        if (useSupabase) {
            const { data: exists } = await supabase.storage.from(BUCKET).exists(doc.storagePath);
            if (!exists) await relinkIfMoved(doc);
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storagePath, 60, { download: doc.fileName });
            if (error) throw new Error(error.message);
            return res.json({ url: data.signedUrl });
        }
        res.set('Content-Type', doc.mimeType || 'application/octet-stream');
        res.set('X-Content-Type-Options', 'nosniff');
        res.attachment(doc.fileName);
        res.send(await readDocBuffer(doc));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AI analysis of one document (one per request keeps each call inside serverless time limits)
router.post('/api/matters/:id/documents/:docId/analyze', async (req, res) => {
    let doc;
    try {
        const started = Date.now();
        doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Step 1 (once): turn the file into text and store it
        let text = null;
        let method = doc.analysis && doc.analysis.method;
        if (!doc.textChars || req.query.reread === '1') {
            const buffer = await readDocBuffer(doc);
            let extracted;
            try {
                extracted = await extractDocumentText(buffer, doc.mimeType, doc.fileName);
            } catch (e) {
                if (!(e instanceof UnsupportedFileError)) throw e;
                const analysis = { status: 'unsupported', error: e.message };
                await saveAnalysis(doc, analysis);
                return res.json(publicDoc({ ...doc, analysis }));
            }
            text = extracted.text || '(no readable text found)';
            method = extracted.method;
            await saveText(doc, text);
            // Long transcriptions: finish the summary in a second request to stay within time limits
            if (Date.now() - started > 25000) {
                return res.json({ ...publicDoc({ ...doc, analysis: null }), continue: true });
            }
        }
        if (text === null) text = (await getDocTexts([doc])).get(doc.id) || '';

        // Step 2: summary, key facts, dates and events from the stored text
        const result = await generateJson([
            { text: `${ANALYSIS_PROMPT}\n\nFile name: ${doc.fileName}\n\nDOCUMENT TEXT:\n${text.slice(0, 1500000)}` }
        ]);
        const analysis = { status: 'done', method, ...result };
        await saveAnalysis(doc, analysis);
        res.json(publicDoc({ ...doc, analysis }));
    } catch (err) {
        console.error('[Documents] Analysis failed:', err.message);
        // Record the failure so the UI can show it; ignore errors while recording
        const message = err.missing ? MISSING_FILE_MESSAGE : err.message;
        if (doc && !/GOOGLE_API_KEY|AI columns/.test(err.message)) {
            try { await saveAnalysis(doc, { status: 'error', error: message }); } catch (_) {}
        }
        res.status(500).json({ error: message });
    }
});

// Rename
router.patch('/api/matters/:id/documents/:docId', async (req, res) => {
    try {
        const doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        const fileName = cleanFileName(req.body.fileName);
        if (!req.body.fileName || !String(req.body.fileName).trim()) return res.status(400).json({ error: 'File name required' });
        if (useSupabase) {
            const { error } = await supabase.from(TABLE).update({ file_name: fileName }).eq('id', doc.id);
            if (error) throw new Error(friendlyDbError(error));
        } else {
            const docs = await readIndex(doc.matterId);
            const target = docs.find(d => d.id === doc.id);
            target.fileName = fileName;
            await writeIndex(doc.matterId, docs);
        }
        res.json(publicDoc({ ...doc, fileName }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove
router.delete('/api/matters/:id/documents/:docId', async (req, res) => {
    try {
        const doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        await removeDoc(doc);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, deleteAllDocuments, listDocs, listAllDocs, listDocAnalyses, buildFileParts, buildTextContext };
