// Unit tests: fact merging, deadlines, form data. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { mergeFacts } = require('../lib/fact-merge');
const intel = require('../lib/case-intel');
const { reading } = require('./mock-gemini');

const doc = (fileName, i = 0) => ({ id: `d${i}`, fileName, createdAt: '2026-10-01T00:00:00Z', analysis: { status: 'done', ...reading(fileName) } });

test('merge: filed complaint and proof of service build the case', () => {
    const m = mergeFacts([doc('FILED Complaint.pdf', 1), doc('Proof of Service.pdf', 2)]);
    assert.strictEqual(m.fields.caseNumber, '25CLB01343');
    assert.strictEqual(m.fields.demandAmount, '18450.22');
    assert.strictEqual(m.dates.complaintFiled, '2025-10-28');
    assert.strictEqual(m.dates.served, '2026-03-17');
    assert.strictEqual(m.fields.serviceType, 'personal');
    assert.strictEqual(m.sources['dates.served'].fileName, 'Proof of Service.pdf');
    assert.ok(m.sources['dates.served'].quote, 'evidence quote kept');
});

test('merge: newest document wins for the debtor address', () => {
    const m = mergeFacts([doc('FILED Complaint.pdf', 1), doc('Proof of Service.pdf', 2)]);
    assert.strictEqual(m.fields.debtorAddress, '123 Main St');
    assert.strictEqual(m.fields.debtorCity, 'Bakersfield');
});

test('merge: a draft never proves a filing date', () => {
    const m = mergeFacts([doc('FILED Complaint.pdf', 1), doc('Request for Default - Shell.pdf', 2)]);
    assert.strictEqual(m.dates.defaultRequested, undefined);
    assert.ok(!m.events.some(e => /default/i.test(e.title)), 'draft filing event dropped');
});

test('merge: credible sources that disagree become a conflict; an override silences it', () => {
    const docs = [doc('Proof of Service.pdf', 1), doc('Declaration of Diligence.pdf', 2)];
    const m = mergeFacts(docs);
    assert.strictEqual(m.dates.served, '2026-03-17');
    const c = m.conflicts.find(x => x.field === 'dates.served');
    assert.ok(c, 'conflict reported');
    assert.deepStrictEqual(c.options.map(o => o.value).sort(), ['2026-03-17', '2026-03-18']);
    const resolved = mergeFacts(docs, { overrides: { 'dates.served': '2026-03-18' } });
    assert.ok(!resolved.conflicts.some(x => x.field === 'dates.served'));
});

test('merge: name spellings are one value, the fullest kept', () => {
    const a = doc('Proof of Service.pdf', 1);
    const b = doc('Letter.pdf', 2);
    b.analysis.fields = { debtorName: 'Erick Acevedo' };
    const m = mergeFacts([a, b]);
    assert.strictEqual(m.fields.debtorName, 'Erick Alonso Acevedo');
    assert.ok(!m.conflicts.some(x => x.field === 'debtorName'));
});

test('merge: duplicate events across documents collapse into one with both sources', () => {
    const m = mergeFacts([doc('Proof of Service.pdf', 1), doc('Declaration of Diligence.pdf', 2)]);
    const service = m.events.filter(e => e.type === 'service');
    assert.strictEqual(service.length, 1);
    assert.strictEqual(service[0].sources.length, 2);
});

test('deadlines: personal service → answer due +30, request default +10 more', () => {
    const matter = { dates: { complaintFiled: '2025-10-28', served: '2026-03-17', serviceType: 'personal' }, serviceType: 'personal', hearings: [], customDeadlines: [] };
    const today = intel.parseDate('2026-10-10');
    const d = intel.computeDeadlines(matter, today);
    const answer = d.find(x => x.key === 'answer_due');
    const def = d.find(x => x.key === 'request_default');
    assert.strictEqual(answer.date, '2026-04-16');
    assert.strictEqual(def.date, '2026-04-26');
    assert.strictEqual(def.status, 'overdue');
    assert.strictEqual(intel.computeStage(matter, today).key, 'default_window');
});

test('deadlines: substituted service adds 10 days', () => {
    const matter = { dates: { served: '2026-03-17', serviceType: 'substituted' }, serviceType: 'substituted', hearings: [], customDeadlines: [] };
    const d = intel.computeDeadlines(matter, intel.parseDate('2026-03-20'));
    assert.strictEqual(d.find(x => x.key === 'answer_due').date, '2026-04-26');
});

test('form data: case facts fill form variables; court address is split', () => {
    const fd = intel.buildFormData({ debtorName: 'Erick Alonso Acevedo', caseNumber: '25CLB01343', courtAddress: '1215 Truxtun Avenue, Bakersfield, CA 93301', costs: '435.00', dates: {} });
    assert.strictEqual(fd['[DEFENDANT_NAME]'], 'Erick Alonso Acevedo');
    assert.strictEqual(fd['[AGAINST_DEFENDANT_NAME]'], 'Erick Alonso Acevedo');
    assert.strictEqual(fd['[COURT_STREET_ADDRESS]'], '1215 Truxtun Avenue');
    assert.strictEqual(fd['[COURT_CITY_ZIP]'], 'Bakersfield, CA 93301');
    assert.strictEqual(fd['[COSTS]'], '435.00');
    assert.strictEqual(fd['[USE_CASE_COURT]'], true);
});
