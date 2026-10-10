// ============================================================
// Case (matter) storage — Supabase table `matters` (JSONB) or local files
// ============================================================
const fs = require('fs').promises;
const path = require('path');
const { deleteAllDocuments } = require('../routes/documents');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (useSupabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Kinecta] Using Supabase for persistent storage | URL:', SUPABASE_URL);
} else {
    console.log('[Kinecta] *** NO SUPABASE *** SUPABASE_URL=' + (SUPABASE_URL ? 'set' : 'MISSING') + ' SUPABASE_KEY=' + (SUPABASE_KEY ? 'set' : 'MISSING'));
    console.log('[Kinecta] Falling back to file storage — DATA WILL BE LOST on Vercel!');
}

// File-based fallback paths
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const MATTERS_DIR = isServerless
    ? path.join('/tmp', 'matters')
    : path.join(__dirname, '..', 'matters');
const NOTIFICATIONS_FILE = isServerless
    ? path.join('/tmp', 'notifications.json')
    : path.join(__dirname, '..', 'data', 'notifications.json');

// Ensure directories exist (file-based only)
if (!useSupabase) {
    (async () => {
        try { await fs.mkdir(MATTERS_DIR, { recursive: true }); } catch (_) {}
        if (!isServerless) {
            try { await fs.mkdir(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (_) {}
        }
    })();
}

async function readMatter(id) {
    let matter;
    if (useSupabase) {
        const { data, error } = await supabase
            .from('matters')
            .select('data')
            .eq('id', id)
            .single();
        if (error) throw new Error('Matter not found');
        matter = data.data;
    } else {
        const filePath = path.join(MATTERS_DIR, `${id}.json`);
        const raw = await fs.readFile(filePath, 'utf-8');
        matter = JSON.parse(raw);
    }
    // Backward compat: ensure arrays exist
    if (!matter.hearings) matter.hearings = [];
    if (!matter.docketUploads) matter.docketUploads = [];
    return matter;
}

async function writeMatter(id, matter) {
    if (useSupabase) {
        const { error } = await supabase
            .from('matters')
            .upsert({
                id,
                data: matter,
                updated_at: new Date().toISOString()
            });
        if (error) throw new Error('Failed to save matter: ' + error.message);
        return;
    }
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(matter, null, 2));
}

async function deleteMatterById(id) {
    await deleteAllDocuments(id);
    if (useSupabase) {
        const { error } = await supabase.from('matters').delete().eq('id', id);
        if (error) throw new Error('Failed to delete: ' + error.message);
        return;
    }
    const filePath = path.join(MATTERS_DIR, `${id}.json`);
    await fs.unlink(filePath);
}

async function listMatters() {
    if (useSupabase) {
        const { data, error } = await supabase
            .from('matters')
            .select('data')
            .order('updated_at', { ascending: false });
        if (error) return [];
        return (data || []).map(row => row.data);
    }
    try {
        const files = await fs.readdir(MATTERS_DIR);
        const matters = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(MATTERS_DIR, file), 'utf-8');
                matters.push(JSON.parse(raw));
            } catch (_) {}
        }
        return matters.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (_) {
        return [];
    }
}

module.exports = {
    supabase, useSupabase, isServerless, MATTERS_DIR, NOTIFICATIONS_FILE,
    readMatter, writeMatter, deleteMatterById, listMatters
};
