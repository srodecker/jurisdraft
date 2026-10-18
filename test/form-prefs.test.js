// Learned form preferences: the fill asks what the documents can't settle, remembers the answer,
// and party names never get "et al." or ", an individual" twice. Run: npm test
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
let server, base, token;
const freePort = () => new Promise(res => { const s = require('net').createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

// What the AI read from the Cazares cover sheet and validation notice
const EXTRACTED = {
    '[ATTY_NAME]': 'Cathy K. Robinson', '[ATTY_SBN]': '226275', '[ATTY_NAME2]': 'Sabaa “Darius” Ghomashchi', '[ATTY_SBN2]': '352285',
    '[FIRM_NAME]': 'Wright, Finlay & Zak, LLP', '[PLAINTIFF_NAME]': 'Kinecta Federal Credit Union',
    '[DEFENDANT_NAME]': 'Manuel Etzael Cazares, et al.', '[DEBTOR1_ADDRESS]': '60 W Blue Sky Dr', '[DEBTOR1_CITY]': 'Heber', '[DEBTOR1_STATE]': 'CA', '[DEBTOR1_ZIP]': '92249',
    '[COURT_COUNTY]': 'Imperial', '[COMPLAINT_FILED]': '2025-07-29'
};

async function fields(res) {
    const body = await res.json();
    const doc = await PDFDocument.load(Buffer.from(body.pdfData, 'base64'));
    const v = { _choices: body.choices };
    for (const f of doc.getForm().getFields()) { try { v[f.getName()] = f.getText ? (f.getText() || '') : ''; } catch (_) {} }
    return v;
}

test.before(async () => {
    const port = await freePort();
    const salt = crypto.randomBytes(16).toString('hex');
    const profile = { username: 'prefs', passwordHash: `${salt}:${crypto.scryptSync('pw', salt, 64).toString('hex')}`, firm: {}, attorneys: [] };
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), JD_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jd-prefs-')), GOOGLE_API_KEY: 'test', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_ANON_KEY: '', PROFILE_PREFS: JSON.stringify(profile) }, stdio: ['ignore', 'ignore', 'inherit'] });
    base = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/auth-status'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
    token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'prefs', password: 'pw' }) })).json()).token;
});
test.after(() => { if (server) server.kill(); });

test('form preferences: asks who signs, caption and nicknames; remembers; one form can differ', async () => {
    const body = { templateName: 'CIV-100 (R4D).pdf', jsonData: EXTRACTED, ask: true };
    const first = await post('/api/fill-pdf', body);
    assert.strictEqual(first.status, 409);
    const { questions } = await first.json();
    assert.deepStrictEqual(questions.map(q => q.id), ['nicknames', 'signer', 'caption']);
    assert.deepStrictEqual(questions[1].options.map(o => o.value), ['robinson', 'ghomashchi']);

    const v = await fields(await post('/api/fill-pdf', { ...body, answers: { nicknames: 'drop', signer: 'ghomashchi', caption: 'signer' }, remember: true }));
    assert.deepStrictEqual(v._choices.map(c => [c.id, c.value, c.source]), [['nicknames', 'drop', 'answer'], ['signer', 'ghomashchi', 'answer'], ['caption', 'signer', 'answer']]);
    assert.strictEqual(v['[VAR_DEFENDANT_NAME_ET_AL]'], 'Manuel Etzael Cazares, et al.', 'one et al.');
    assert.strictEqual(v['[VAR_DEFENDANT_INDIVIDUAL]'], 'Manuel Etzael Cazares, an individual');
    assert.match(v['[VAR_DEFENDANT_NAME_WITH_ADDRESS_NO_INDIVIDUAL]'], /^Manuel Etzael Cazares\n60 W Blue Sky Dr/);
    assert.strictEqual(v['[VAR_ATTY_NAME2]'], 'Sabaa Ghomashchi, Esq.');
    assert.strictEqual(v['[VAR_ATTY2_NAME]'], 'Sabaa Ghomashchi, SBN: 352285');
    assert.strictEqual(v['[VAR_ATTY_WITH_SBN]'], 'Sabaa Ghomashchi, Esq., SBN 352285', 'caption: only the signer');

    // Remembered: no questions the next time
    const again = await post('/api/fill-pdf', body);
    assert.strictEqual(again.status, 200);
    assert.ok((await again.json()).choices.every(c => c.source === 'usual'), 'reported as the usual');
    const prefs = await (await fetch(base + '/api/form-prefs', { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepStrictEqual(prefs.prefs, { nicknames: 'drop', signer: 'ghomashchi', caption: 'signer' });

    // This one form differently, in plain words, without changing the usual
    const both = await fields(await post('/api/fill-pdf', { ...body, answers: { signer: 'Cathy', caption: 'both' } }));
    assert.strictEqual(both['[VAR_ATTY_NAME2]'], 'Cathy K. Robinson, Esq.');
    assert.strictEqual(both['[VAR_ATTY_WITH_SBN]'], 'Cathy K. Robinson, Esq., SBN 226275; Sabaa Ghomashchi, Esq., SBN 352285');
    const still = await (await fetch(base + '/api/form-prefs', { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.strictEqual(still.prefs.signer, 'ghomashchi', 'usual unchanged');

    // Forget → asks again
    await fetch(base + '/api/form-prefs/signer', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    const asked = await post('/api/fill-pdf', body);
    assert.strictEqual(asked.status, 409);
    assert.deepStrictEqual((await asked.json()).questions.map(q => q.id), ['signer']);
});
