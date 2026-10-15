// Forms v2 vs the original engine: fill the same case with both and compare every field.
// The renamed template must give the same text in every box (or a listed, intended difference).
// FORMS_V2_REPORT=path writes a markdown comparison table.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createMock } = require('./mock-gemini');

const ROOT = path.join(__dirname, '..');
const FORM = 'CIV-100 (R4D).pdf';
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'v2', 'maps', 'CIV-100 (R4D).json'), 'utf8'));

// Old field → reason the new engine intentionally differs
const INTENDED = {
    '[VAR_ATTY_WITH_SBN]': 'Fixed: original doubled "Esq., Esq." when the attorney name in Settings already ends in Esq.',
    '[VAR_ATTY_NAME2]': 'Fixed: same "Esq., Esq." doubling',
    '[VAR_ATTY2_NAME]': 'Fixed: "Esq." from Settings leaked into "Name, SBN: #" (documents never include it)',
    '[PLAINTIFF_NAME_P2]': 'Fixed: original left the page-2 caption plaintiff blank',
    '[AGAINST_DEFENDANT_NAME]': 'Changed: item 1d (court judgment) stays blank on a request for entry of default — it was filled with the defendant name'
};

let server, mock, base, token;
const freePort = () => new Promise(res => { const s = require('net').createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function call(method, url, body, raw) {
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(base + url, opts);
    if (raw) return r;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${d.error || ''}`);
    return d;
}

test.before(async () => {
    const mockPort = await freePort();
    const app = createMock(); app.port = mockPort; mock = app.listen(mockPort);
    const port = await freePort();
    const salt = crypto.randomBytes(16).toString('hex');
    const profile = { username: 'formstester', passwordHash: `${salt}:${crypto.scryptSync('pw', salt, 64).toString('hex')}`, firm: {}, attorneys: [] };
    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), JD_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jd-forms-')), GOOGLE_API_KEY: 'test', GEMINI_API_BASE: `http://localhost:${mockPort}`, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_ANON_KEY: '', PROFILE_FORMSTESTER: JSON.stringify(profile), FORMS_ENGINE: '' },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    base = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/auth-status'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
    token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'formstester', password: 'pw' }) })).json()).token;
});
test.after(() => { if (server) server.kill(); if (mock) mock.close(); });

async function fieldValues(buf) {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const out = {};
    for (const f of doc.getForm().getFields()) {
        if (typeof f.getText === 'function') out[f.getName()] = f.getText() || '';
        else if (typeof f.isChecked === 'function') out[f.getName()] = f.isChecked() ? '☑' : '☐';
    }
    return out;
}

test('CIV-100 (R4D): new engine fills every box the same as the original', async () => {
    // A case built from documents (mock AI), plus firm settings and a cost entered by hand
    const m = await call('POST', '/api/cases', { debtorName: 'Acevedo, Erick' });
    const form = new FormData();
    for (const n of ['FILED Complaint.pdf', 'Proof of Service.pdf', 'Payoff statement.pdf']) form.append('files', new Blob([`%PDF-1.4\n${n}`], { type: 'application/pdf' }), n);
    await call('POST', `/api/matters/${m.id}/documents`, form);
    for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/jobs/tick', { caseId: m.id }); if (!r.remaining) break; }
    await call('PUT', '/api/profile', {
        firm: { name: 'WRIGHT, FINLAY & ZAK, LLP', address: '4665 MacArthur Court, Suite 200', city: 'Newport Beach', state: 'CA', zip: '92660', phone: '(949) 477-5050', fax: '(949) 608-9142' },
        attorneys: [{ name: 'Gwen H. Ribar', sbn: '188024', email: 'gribar@wrightlegal.net' }, { name: 'Sabaa Ghomashchi, Esq.', sbn: '352285', email: 'sghomashchi@wrightlegal.net' }]
    });
    await call('PATCH', `/api/cases/${m.id}/facts`, { updates: { costs: '435.00' } });

    const v1 = await call('POST', `/api/cases/${m.id}/forms`, { form: FORM, engine: 'v1' });
    const v2 = await call('POST', `/api/cases/${m.id}/forms`, { form: FORM, engine: 'v2' });
    assert.strictEqual(v1.engine, 'v1');
    assert.strictEqual(v2.engine, 'v2');
    assert.deepStrictEqual(v2.unknown, [], 'every field name is understood');
    const pdf1 = Buffer.from(await (await call('GET', `/api/cases/${m.id}/forms/${v1.id}/download`, undefined, true)).arrayBuffer());
    const pdf2 = Buffer.from(await (await call('GET', `/api/cases/${m.id}/forms/${v2.id}/download`, undefined, true)).arrayBuffer());
    if (process.env.FORMS_V2_PDF) { fs.writeFileSync(process.env.FORMS_V2_PDF, pdf2); fs.writeFileSync(process.env.FORMS_V2_PDF.replace(/\.pdf$/, '-original.pdf'), pdf1); }
    const a = await fieldValues(pdf1), b = await fieldValues(pdf2);

    const rows = [];
    const diffs = [];
    for (const [oldName, newName] of Object.entries(MAP)) {
        if (oldName.startsWith('_')) continue;
        const was = a[oldName] ?? '(no field)';
        const now = b[newName] ?? '(no field)';
        const same = was === now;
        rows.push({ oldName, newName, was, now, same, note: same ? '' : INTENDED[oldName] || 'DIFFERENT' });
        if (!same && !INTENDED[oldName]) diffs.push(`${oldName} → ${newName}: "${was}" vs "${now}"`);
    }
    if (process.env.FORMS_V2_REPORT) {
        const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, '<br>') || '·';
        const md = [`# ${FORM}: original engine vs forms v2`, '', `${rows.filter(r => r.same).length} of ${rows.length} fields identical.`, '',
            '| Old field | New field | Original output | New output | |', '|---|---|---|---|---|',
            ...rows.map(r => `| \`${r.oldName}\` | \`${r.newName}\` | ${cell(r.was)} | ${cell(r.now)} | ${r.same ? '✓' : '**' + r.note + '**'} |`)].join('\n');
        fs.writeFileSync(process.env.FORMS_V2_REPORT, md + '\n');
    }
    assert.deepStrictEqual(diffs, [], 'fields differ:\n' + diffs.join('\n'));
    assert.ok(rows.filter(r => r.was && r.was !== '☐').length > 15, 'the comparison actually covered filled fields');
});
