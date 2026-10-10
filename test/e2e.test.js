// End-to-end: boots the real server (file storage in a temp dir) against the mock Gemini API
// and drives the case-manager flow over HTTP. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMock } = require('./mock-gemini');

const ROOT = path.join(__dirname, '..');
let server, mock, base, token;

function freePort() {
    return new Promise(res => { const s = require('net').createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function call(method, url, body, { raw = false } = {}) {
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
    const app = createMock();
    app.port = mockPort;
    mock = app.listen(mockPort);
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-test-'));
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${crypto.scryptSync('testpass', salt, 64).toString('hex')}`;
    const profile = { username: 'e2etester', passwordHash, firm: {}, attorneys: [] };
    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), JD_DATA_DIR: dataDir, GOOGLE_API_KEY: 'test', GEMINI_API_BASE: `http://localhost:${mockPort}`, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_ANON_KEY: '', PROFILE_E2ETESTER: JSON.stringify(profile) },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    base = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/auth-status'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
    }
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2etester', password: 'testpass' }) });
    token = (await r.json()).token;
    assert.ok(token, 'logged in');
});

test.after(() => { if (server) server.kill(); if (mock) mock.close(); });

let caseId;

test('create a case and upload documents', async () => {
    const m = await call('POST', '/api/cases', { debtorName: 'Acevedo, Erick' });
    caseId = m.id;
    const form = new FormData();
    for (const name of ['FILED Complaint.pdf', 'Proof of Service.pdf', 'Declaration of Diligence.pdf', 'Payoff statement.pdf', 'Request for Default - Shell.pdf']) {
        form.append('files', new Blob([`%PDF-1.4\n${name}`], { type: 'application/pdf' }), name);
    }
    const up = await call('POST', `/api/matters/${caseId}/documents`, form);
    assert.strictEqual(up.documents.length, 5);
    const st = await call('GET', `/api/jobs/status?caseId=${caseId}`);
    assert.strictEqual(st.remaining, 5);
});

test('the queue reads every document and builds the case', async () => {
    let r;
    for (let i = 0; i < 10; i++) { r = await call('POST', '/api/jobs/tick', { caseId }); if (!r.remaining) break; }
    assert.strictEqual(r.remaining, 0);
    const v = await call('GET', `/api/cases/${caseId}`);
    const m = v.matter;
    assert.ok(v.documents.every(d => d.analysisStatus === 'done'));
    assert.strictEqual(m.debtorName, 'Erick Alonso Acevedo');
    assert.strictEqual(m.caseNumber, '25CLB01343');
    assert.strictEqual(m.dates.served, '2026-03-17');
    assert.strictEqual(m.payoffBalance, '19000.55');
    assert.ok(m.summary, 'summary written');
    assert.ok(m.nextStep, 'next step written');
    assert.strictEqual(m.dates.defaultRequested, null, 'draft ignored');
    assert.strictEqual(v.stage.key, 'default_window');
    assert.ok(m.factConflicts.some(c => c.field === 'dates.served'), 'service-date conflict surfaced');
    const extracted = v.documents.find(d => d.fileName === 'Proof of Service.pdf').extracted;
    assert.ok(extracted.some(f => f.key === 'dates.served' && f.quote));
});

test('resolving a conflict keeps the chosen value through a rebuild', async () => {
    const r = await call('PATCH', `/api/cases/${caseId}/facts`, { updates: { 'dates.served': '2026-03-17' } });
    assert.ok(!r.matter.factConflicts.some(c => c.field === 'dates.served'));
    const rb = await call('POST', `/api/matters/${caseId}/rebuild-from-documents?facts=only`);
    assert.strictEqual(rb.matter.dates.served, '2026-03-17');
    assert.ok(!rb.matter.factConflicts.some(c => c.field === 'dates.served'));
});

test('a document that keeps failing is retried, then reported without blocking the case', async () => {
    const form = new FormData();
    form.append('files', new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }), 'Will fail.pdf');
    await call('POST', `/api/matters/${caseId}/documents`, form);
    const r = await call('POST', '/api/jobs/tick', { caseId });
    assert.ok(r.processed.some(p => p.result === 'retry'));
    const v = await call('GET', `/api/cases/${caseId}`);
    assert.ok(v.matter.summary, 'case still has its summary');
    const failed = v.documents.find(d => d.fileName === 'Will fail.pdf');
    assert.strictEqual(failed.analysisStatus, 'queued');
    assert.ok(failed.analysisError);
    await call('DELETE', `/api/matters/${caseId}/documents/${failed.id}`);
});

test('forms, packages and the combined PDF', async () => {
    const rec = await call('POST', `/api/cases/${caseId}/forms`, { form: 'CIV-100 (R4D).pdf' });
    assert.ok(rec.filledCount > 10);
    assert.strictEqual(rec.filled['[CASE_NUMBER]'], '25CLB01343');
    const pkg = await call('POST', `/api/cases/${caseId}/packages`, { package: 'judgment' });
    assert.strictEqual(pkg.records.length, 3);
    assert.deepStrictEqual(pkg.errors, []);
    const ids = pkg.records.filter(x => /pdf/.test(x.contentType)).map(x => x.id).join(',');
    const pdf = await call('GET', `/api/cases/${caseId}/forms-merged?ids=${ids}`, undefined, { raw: true });
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 10000);
});

test('firm settings persist and fill forms', async () => {
    await call('PUT', '/api/profile', { firm: { name: 'Test Firm LLP', address: '1 Main St', city: 'Irvine', state: 'CA', zip: '92618', phone: '(949) 555-0100', fax: '' }, attorneys: [{ name: 'Jane Lawyer', sbn: '123456', email: 'j@example.com' }] });
    const p = await call('GET', '/api/profile');
    assert.strictEqual(p.firm.name, 'Test Firm LLP');
    const rec = await call('POST', `/api/cases/${caseId}/forms`, { form: 'CIV-100 (R4D).pdf' });
    assert.strictEqual(rec.filled['[FIRM_PHONE]'], '(949) 555-0100');
    assert.ok(!rec.missing.includes('[FIRM_ADDRESS]'));
});

test('calendar, ICS feed, client report and Excel export', async () => {
    const cal = await call('GET', '/api/calendar?from=2026-01-01&to=2026-12-31');
    assert.ok(cal.items.some(i => i.key === 'request_default' && i.caseId === caseId));
    const { url } = await call('GET', '/api/calendar/feed');
    const ics = await (await fetch(url.replace(/^https?:\/\/[^/]+/, base))).text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /Request entry of default/);
    const bad = await fetch(base + '/ics/e2etester/wrongtoken/deadlines.ics');
    assert.strictEqual(bad.status, 404);
    const rep = await call('GET', '/api/reports/portfolio');
    const row = rep.rows.find(r => r.id === caseId);
    assert.strictEqual(row.stage, 'Request default');
    assert.ok(row.nextStep);
    const x = await call('GET', '/api/reports/portfolio.xlsx', undefined, { raw: true });
    assert.strictEqual(x.status, 200);
    assert.ok((await x.arrayBuffer()).byteLength > 1000);
});

test('assistant prepares a form on request', async () => {
    const r = await call('POST', '/api/assistant', { message: 'fill out the request for default for acevedo' });
    assert.match(r.message.content, /\[\[form:[0-9a-f-]{36}:[0-9a-f-]{36}\|/);
    assert.ok(r.changedCases.includes(caseId));
});

test('the app shell and modules are served', async () => {
    const html = await (await fetch(base + '/kinecta')).text();
    assert.match(html, /\/app\/main\.js/);
    for (const f of ['main.js', 'core.js', 'queue.js', 'chat.js', 'palette.js', 'app.css', 'views/case.js', 'views/documents.js', 'views/forms.js', 'views/calendar.js', 'views/reports.js', 'views/settings.js', 'views/today.js', 'views/cases.js']) {
        const r = await fetch(`${base}/app/${f}`);
        assert.strictEqual(r.status, 200, f);
    }
});
