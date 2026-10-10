// ============================================================
// Per-user settings that must survive serverless deploys (firm info, attorneys).
// Supabase: a JSON file in the private documents bucket (settings/<user>.json) — no schema change.
// File mode: settings/<user>.json next to the app.
// Cached per instance for a minute; writes refresh the cache.
// ============================================================
const fs = require('fs').promises;
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET || 'case-documents';
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const LOCAL_DIR = process.env.JD_DATA_DIR ? path.join(process.env.JD_DATA_DIR, 'settings') : isServerless ? path.join('/tmp', 'settings') : path.join(__dirname, '..', 'settings');

let supabase = null;
if (useSupabase) supabase = require('@supabase/supabase-js').createClient(SUPABASE_URL, SUPABASE_KEY);

const cache = new Map();
const TTL = 60 * 1000;
const safe = u => String(u || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');

async function getSettings(username) {
    const key = safe(username);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    let value = {};
    try {
        if (useSupabase) {
            const { data, error } = await supabase.storage.from(BUCKET).download(`settings/${key}.json`);
            if (!error && data) value = JSON.parse(Buffer.from(await data.arrayBuffer()).toString('utf8'));
        } else {
            value = JSON.parse(await fs.readFile(path.join(LOCAL_DIR, `${key}.json`), 'utf8'));
        }
    } catch (_) { value = {}; }
    cache.set(key, { at: Date.now(), value });
    return value;
}

async function saveSettings(username, value) {
    const key = safe(username);
    const body = JSON.stringify(value, null, 2);
    if (useSupabase) {
        const { error } = await supabase.storage.from(BUCKET).upload(`settings/${key}.json`, Buffer.from(body), { contentType: 'application/json', upsert: true });
        if (error) throw new Error(`Could not save settings: ${error.message}`);
    } else {
        await fs.mkdir(LOCAL_DIR, { recursive: true });
        await fs.writeFile(path.join(LOCAL_DIR, `${key}.json`), body);
    }
    cache.set(key, { at: Date.now(), value });
    return value;
}

// Profile + saved settings (settings win for firm and attorneys)
async function overlayProfile(username, profile) {
    const s = await getSettings(username);
    const out = { ...profile };
    if (s.firm && Object.values(s.firm).some(v => v)) out.firm = { ...(profile.firm || {}), ...s.firm };
    if (Array.isArray(s.attorneys) && s.attorneys.length) out.attorneys = s.attorneys;
    if (s.preferences) out.preferences = s.preferences;
    return out;
}

module.exports = { getSettings, saveSettings, overlayProfile };
