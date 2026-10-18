// Filing forms (CM-010, LASC, CM-180): fill a case with the current engine and check the key boxes. Run: npm test
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const { PDFDocument } = require('pdf-lib');
const { createMock } = require('./mock-gemini');
let server, mock, base, token;
const freePort = () => new Promise(res => { const s = require('net').createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function call(method, url, body, raw) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) opts.body = body; else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(base + url, opts); if (raw) return r;
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${d.error || ''}`); return d;
}
test('filing forms: CM-010, LASC and CM-180 fill the right boxes', async () => {
  const mp = await freePort(); const app = createMock(); app.port = mp; mock = app.listen(mp);
  const port = await freePort(); const salt = crypto.randomBytes(16).toString('hex');
  const profile = { username: 'ft', passwordHash: `${salt}:${crypto.scryptSync('pw', salt, 64).toString('hex')}`, firm: {}, attorneys: [] };
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), JD_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jd-f-')), GOOGLE_API_KEY: 'test', GEMINI_API_BASE: `http://localhost:${mp}`, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_ANON_KEY: '', PROFILE_FT: JSON.stringify(profile) }, stdio: ['ignore', 'ignore', 'inherit'] });
  base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/auth-status'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ft', password: 'pw' }) })).json()).token;
  try {
    const m = await call('POST', '/api/cases', { debtorName: 'Acevedo, Erick' });
    const form = new FormData();
    for (const n of ['FILED Complaint.pdf', 'Proof of Service.pdf', 'Payoff statement.pdf']) form.append('files', new Blob([`%PDF-1.4\n${n}`], { type: 'application/pdf' }), n);
    await call('POST', `/api/matters/${m.id}/documents`, form);
    for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/jobs/tick', { caseId: m.id }); if (!r.remaining) break; }
    await call('PUT', '/api/profile', { firm: { name: 'WRIGHT, FINLAY & ZAK, LLP', address: '4665 MacArthur Court, Suite 200', city: 'Newport Beach', state: 'CA', zip: '92660', phone: '(949) 477-5050', fax: '(949) 608-9142' },
      attorneys: [{ name: 'Gwen H. Ribar', sbn: '188024', email: 'gribar@wrightlegal.net' }, { name: 'Sabaa Ghomashchi, Esq.', sbn: '352285', email: 'sghomashchi@wrightlegal.net' }] });
    if (process.env.FACTS) await call('PATCH', `/api/cases/${m.id}/facts`, { updates: JSON.parse(process.env.FACTS) });
    const fill = async f => {
      const rec = await call('POST', `/api/cases/${m.id}/forms`, { form: f, values: { '[RAW_IS_BREACH_OF_CONTRACT]': true, '[NUMBER_OF_CAUSES]': '2' } });
      const buf = Buffer.from(await (await call('GET', `/api/cases/${m.id}/forms/${rec.id}/download`, undefined, true)).arrayBuffer());
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true }); const v = {};
      for (const x of doc.getForm().getFields()) { try { v[x.getName()] = x.getText ? (x.getText() || '') : x.isChecked ? x.isChecked() : ''; } catch (_) {} }
      return v;
    };
    const cm010 = await fill('CM-010.pdf');
    assert.strictEqual(cm010['[ATTY_SBN]'], '188024', 'CM-010 state bar box');
    assert.strictEqual(cm010['[VAR_ATTY_WITH_SBN]'], 'Gwen H. Ribar, Esq., SBN 188024; Sabaa Ghomashchi, Esq., SBN 352285', 'CM-010 name line, no doubled Esq.');
    assert.strictEqual(cm010['[FIRM_ADDRESS]'], '4665 MacArthur Court, Suite 200');
    assert.strictEqual(cm010['[FIRM_ZIP]'], '92660');
    assert.strictEqual(cm010['[IS_BREACH_OF_CONTRACT_06]'], true);
    assert.strictEqual(cm010['[NUMBER_OF_CAUSES]'], '2 (TWO)');
    const lasc = await fill('LASC.pdf');
    assert.match(lasc['[VAR_CASE_NAME]'], /Kinecta Federal Credit Union v\. Erick Alonso Acevedo/);
    assert.strictEqual(lasc['[IS_BREACH_OF_CONTRACT_06]'], true, 'LASC 0604');
    assert.strictEqual(lasc['[IS_REASON5]'], true);
    const cm180 = await fill('CM-180.pdf');
    assert.strictEqual(cm180['[VAR_ATTY_BLOCK]'].split('\n')[2], 'Wright, Finlay & Zak, LLP');
    assert.strictEqual(cm180['[PLAINTIFF_NAME]'], 'Kinecta Federal Credit Union');
    assert.strictEqual(cm180['[VAR_DEFENDANT_NAME_ET_AL]'], 'Erick Alonso Acevedo, et al.');
    assert.strictEqual(cm180['[VAR_ATTY_NAME2]'], 'Sabaa Ghomashchi, Esq.', 'declarant and signature name');
    for (const k of ['[IS_STAY_1B]', '[IS_STAY_1B_ATTORNEY]', '[IS_STAY_ALL_PARTIES]', '[IS_STAY_BANKRUPTCY]']) assert.strictEqual(cm180[k], true, k);
    assert.strictEqual(cm180['[IS_STAY_1A]'], false);
  } finally { server.kill(); mock.close(); }
});
