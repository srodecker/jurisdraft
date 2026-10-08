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
const { fileToParts, generateJson } = require('../lib/gemini');

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
        analyzedAt: row.analyzed_at || null
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
    const { storagePath, analysis, ...rest } = doc;
    return {
        ...rest,
        analysisStatus: analysis ? analysis.status : 'none',
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
    if (/analy[sz]ed?_at|column .*analysis/i.test(msg)) {
        return 'Documents table needs the AI analysis columns. Run: ALTER TABLE case_documents ADD COLUMN IF NOT EXISTS analysis JSONB, ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;';
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

// --- Backend-agnostic data access ---
async function listDocs(matterId) {
    if (useSupabase) {
        const { data, error } = await supabase.from(TABLE).select('*').eq('matter_id', matterId).order('created_at', { ascending: false });
        if (error) throw new Error(friendlyDbError(error));
        return data.map(r => ({ ...rowToDoc(r), storagePath: r.storage_path }));
    }
    const docs = await readIndex(matterId);
    return docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getDoc(matterId, docId) {
    if (!UUID_RE.test(docId)) return null;
    if (useSupabase) {
        const { data, error } = await supabase.from(TABLE).select('*').eq('id', docId).eq('matter_id', matterId).maybeSingle();
        if (error) throw new Error(friendlyDbError(error));
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

async function readDocBuffer(doc) {
    if (useSupabase) {
        const { data, error } = await supabase.storage.from(BUCKET).download(doc.storagePath);
        if (error) throw new Error(`Could not read "${doc.fileName}" from storage: ${error.message}`);
        return Buffer.from(await data.arrayBuffer());
    }
    return fs.readFile(path.join(DOCS_DIR, doc.storagePath));
}

async function saveAnalysis(doc, analysis) {
    const analyzedAt = new Date().toISOString();
    if (useSupabase) {
        const { error } = await supabase.from(TABLE).update({ analysis, analyzed_at: analyzedAt }).eq('id', doc.id);
        if (error) throw new Error(friendlyDbError(error));
        return;
    }
    const docs = await readIndex(doc.matterId);
    const target = docs.find(d => d.id === doc.id);
    if (target) {
        target.analysis = analysis;
        target.analyzedAt = analyzedAt;
        await writeIndex(doc.matterId, docs);
    }
}

// All documents for a matter with their stored AI analysis (server-side use only)
async function listDocAnalyses(matterId) {
    const docs = await listDocs(matterId);
    return docs.map(d => ({ id: d.id, matterId: d.matterId, fileName: d.fileName, createdAt: d.createdAt, analysis: d.analysis || null }));
}

// Same, for every matter at once → Map(matterId → docs[])
async function listAllDocAnalyses() {
    const byMatter = new Map();
    const add = d => {
        if (!byMatter.has(d.matterId)) byMatter.set(d.matterId, []);
        byMatter.get(d.matterId).push({ id: d.id, matterId: d.matterId, fileName: d.fileName, createdAt: d.createdAt, analysis: d.analysis || null });
    };
    if (useSupabase) {
        const { data, error } = await supabase.from(TABLE).select('*');
        if (error) throw new Error(friendlyDbError(error));
        data.map(rowToDoc).forEach(add);
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
Read the attached case document completely and return ONE JSON object describing it. Use only information actually in the document — never guess. Omit fields you cannot find.

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
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storagePath, 60, { download: doc.fileName });
            if (error) throw new Error(error.message);
            return res.json({ url: data.signedUrl });
        }
        res.set('Content-Type', doc.mimeType || 'application/octet-stream');
        res.set('X-Content-Type-Options', 'nosniff');
        res.attachment(doc.fileName);
        res.send(await fs.readFile(path.join(DOCS_DIR, doc.storagePath)));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AI analysis of one document (one per request keeps each call inside serverless time limits)
router.post('/api/matters/:id/documents/:docId/analyze', async (req, res) => {
    let doc;
    try {
        doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        const buffer = await readDocBuffer(doc);
        const converted = await fileToParts(buffer, doc.mimeType, doc.fileName);
        let analysis;
        if (converted.unsupported) {
            analysis = { status: 'unsupported', error: converted.unsupported };
        } else {
            const result = await generateJson([
                { text: `${ANALYSIS_PROMPT}\n\nFile name: ${doc.fileName}` },
                ...converted.parts
            ]);
            analysis = { status: 'done', ...result };
        }
        await saveAnalysis(doc, analysis);
        res.json(publicDoc({ ...doc, analysis }));
    } catch (err) {
        console.error('[Documents] Analysis failed:', err.message);
        // Record the failure so the UI can show it; ignore errors while recording
        if (doc && !/GOOGLE_API_KEY|analysis columns/.test(err.message)) {
            try { await saveAnalysis(doc, { status: 'error', error: err.message }); } catch (_) {}
        }
        res.status(500).json({ error: err.message });
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

module.exports = { router, deleteAllDocuments, listDocAnalyses, listAllDocAnalyses };
