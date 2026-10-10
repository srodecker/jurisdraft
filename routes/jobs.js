// ============================================================
// Background work endpoints: drive the document pipeline, report progress,
// retry a document. /api/jobs accepts a signed-in user or the CRON_SECRET header.
// ============================================================
const express = require('express');
const pipeline = require('../lib/doc-pipeline');
const { getDoc, publicDoc, docStatus, isSchemaError, SCHEMA_FIX_SQL } = require('./documents');

const router = express.Router();

function schemaAware(res, err) {
    if (isSchemaError(err.message)) return res.status(500).json({ error: err.message, code: 'SCHEMA', sql: SCHEMA_FIX_SQL });
    res.status(500).json({ error: err.message });
}

// Do a slice of pending work (reading documents, rebuilding cases). Call again while remaining > 0.
router.post('/api/jobs/tick', async (req, res) => {
    try {
        const caseId = req.body && req.body.caseId ? String(req.body.caseId) : null;
        const result = await pipeline.tick({ matterId: caseId });
        res.json(result);
    } catch (err) {
        console.error('[Jobs] Tick failed:', err.message);
        schemaAware(res, err);
    }
});

// Progress without doing work
router.get('/api/jobs/status', async (req, res) => {
    try {
        const caseId = req.query.caseId ? String(req.query.caseId) : null;
        const { all, work } = await pipeline.loadWork(caseId);
        const progress = pipeline.progressOf(all);
        const remaining = all.filter(d => pipeline.workFor(d) || ['queued', 'reading'].includes(docStatus(d))).length;
        res.json({ remaining, progress });
    } catch (err) {
        schemaAware(res, err);
    }
});

// Retry a failed document, re-extract facts from its stored text, or re-read the file from scratch
router.post('/api/matters/:id/documents/:docId/retry', async (req, res) => {
    try {
        const doc = await getDoc(req.params.id, req.params.docId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        await pipeline.retryDoc(doc, { reextract: !!(req.body && req.body.reextract), reread: !!(req.body && req.body.reread) });
        res.json(publicDoc(await getDoc(req.params.id, req.params.docId)));
    } catch (err) {
        schemaAware(res, err);
    }
});

module.exports = router;
