// Mock of the Gemini REST API for local tests.
// Point the app at it with GEMINI_API_BASE=http://localhost:<port> and any GOOGLE_API_KEY.
// Document readings depend on the file name so tests can build realistic cases:
//   complaint, proof (of service), diligence (conflicting service date), payoff, draft/shell, fail (always errors)
const express = require('express');
const fs = require('fs');

function createMock({ log = null } = {}) {
    const app = express();
    app.use(express.json({ limit: '200mb' }));
    app.use(express.raw({ type: () => true, limit: '200mb' }));
    const record = (kind, extra) => { if (log) fs.appendFileSync(log, JSON.stringify({ kind, ...extra }) + '\n'); };
    const reply = (res, obj) => res.json({ candidates: [{ content: { role: 'model', parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }] });
    const call = (res, name, args) => res.json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }] });
    let n = 0;

    app.post('/upload/v1beta/files', (req, res) => { res.set('x-goog-upload-url', `http://localhost:${app.port}/upload-target`).json({}); });
    app.post('/upload-target', (req, res) => {
        n++;
        res.json({ file: { name: 'files/f' + n, uri: 'https://mock/files/f' + n, state: 'ACTIVE', mimeType: 'application/pdf', expirationTime: new Date(Date.now() + 48 * 3600e3).toISOString() } });
    });

    app.post('/v1beta/models/:model', (req, res) => {
        const body = req.body;
        if (body.tools) return chat(body, res);
        const text = (body.contents[0].parts.find(p => p.text) || {}).text || '';
        if (text.startsWith('Transcribe ALL text')) {
            record('transcribe', {});
            return reply(res, '--- Page 1 ---\nPROOF OF SERVICE OF SUMMONS. I served Erick Alonso Acevedo personally on 03/17/2026 at 6:12 PM at 123 Main St, Bakersfield CA 93301.');
        }
        if (text.includes('MERGED CASE FACTS')) {
            record('synthesize', { hasFacts: text.includes('"dates.served"') });
            return reply(res, {
                summary: 'Kinecta Federal Credit Union sued Erick Alonso Acevedo for an unpaid auto loan. He was personally served March 17, 2026 and has not answered.',
                keyFacts: ['Complaint filed 10/28/2025 (FILED Complaint.pdf)', 'Personally served 03/17/2026 (Proof of Service.pdf)'],
                statusText: 'Served 3/17/2026 — no answer; default may be requested',
                nextStep: 'Request entry of default (CIV-100) — overdue since April 26, 2026.',
                formData: { '[PLAINTIFF_NAME]': 'Kinecta Federal Credit Union', '[DEFENDANT_NAME]': 'Erick Alonso Acevedo', '[CASE_NUMBER]': '25CLB01343', '[COMPLAINT_FILED]': 'October 28, 2025', '[COURT_COUNTY]': 'Kern', '[COURT_STREET_ADDRESS]': '1215 Truxtun Avenue', '[COURT_CITY_ZIP]': 'Bakersfield, CA 93301', '[COURT_BRANCH_NAME]': 'Metropolitan Division', '[DEMAND_AMOUNT]': '18450.22' }
            });
        }
        const file = (text.match(/File name: (.*)/) || [])[1] || '?';
        record('analyze', { file });
        if (/fail/i.test(file)) return res.status(500).json({ error: { message: 'mock failure' } });
        return reply(res, reading(file));
    });

    function chat(body, res) {
        const last = body.contents[body.contents.length - 1];
        const fr = last.parts.find(p => p.functionResponse);
        if (fr) {
            const r = fr.functionResponse.response.result;
            record('tool_result', { name: fr.functionResponse.name });
            if (r.error) return reply(res, `Tool error: ${r.error}`);
            if (fr.functionResponse.name === 'fill_form') return reply(res, `Prepared **${r.prepared}** for ${r.case}. Missing: ${(r.missing || []).join(', ') || 'nothing'}.`);
            return reply(res, 'Done: ' + JSON.stringify(r).slice(0, 300));
        }
        const q = last.parts.map(p => p.text || '').join(' ').toLowerCase();
        if (q.includes('request for default') || q.includes('fill')) return call(res, 'fill_form', { case_id: 'Acevedo', form: 'CIV-100 (R4D).pdf', field_values: [{ variable: '[COSTS]', value: '435.00' }] });
        if (q.includes('attention')) return call(res, 'cases_needing_attention', {});
        return reply(res, 'Per **Proof of Service.pdf**, Erick Alonso Acevedo was personally served on **March 17, 2026**.');
    }

    return app;
}

function reading(file) {
    const base = { summary: `Summary of ${file}.`, keyFacts: [`Fact from ${file}`], isDraft: false, filedWithCourt: false, fields: {}, dates: {}, evidence: {}, events: [], hearings: [] };
    if (/draft|shell/i.test(file)) {
        return { ...base, documentType: 'Request for Entry of Default', isDraft: true, documentDate: '2026-05-01', dates: { defaultRequested: '2026-05-01' }, fields: { debtorName: 'Erick Acevedo' }, events: [{ type: 'filing', title: 'Request for default filed', date: '2026-05-01' }] };
    }
    if (/complaint/i.test(file)) {
        return {
            ...base, documentType: 'Complaint', documentDate: '2025-10-28', filedWithCourt: true,
            fields: { debtorName: 'Erick Alonso Acevedo', caseNumber: '25CLB01343', courtName: 'Superior Court of California, County of Kern', courtBranch: 'Metropolitan Division', courtAddress: '1215 Truxtun Avenue, Bakersfield, CA 93301', courtCounty: 'Kern', creditorName: 'Kinecta Federal Credit Union', demandAmount: '18,450.22', loanType: 'Auto loan', debtorAddress: '99 Old Rd', debtorCity: 'Fresno', debtorState: 'CA', debtorZip: '93701' },
            dates: { complaintFiled: '2025-10-28' },
            evidence: { caseNumber: 'Case No. 25CLB01343', demandAmount: 'the sum of $18,450.22', 'dates.complaintFiled': 'FILED Oct 28 2025' },
            events: [{ type: 'filing', title: 'Complaint filed', date: '2025-10-28' }],
            hearings: [{ type: 'OSC re: Default Judgment', date: '2026-11-05', time: '8:30 AM', department: 'Dept. 12', status: 'Scheduled' }]
        };
    }
    if (/proof/i.test(file)) {
        return {
            ...base, documentType: 'Proof of Service of Summons', documentDate: '2026-03-20', filedWithCourt: true,
            fields: { debtorName: 'Erick Alonso Acevedo', serviceType: 'Personal', servedBy: 'Eddie Ruiz, Nationwide Legal', serviceAddress: '123 Main St, Bakersfield, CA 93301', debtorAddress: '123 Main St', debtorCity: 'Bakersfield', debtorState: 'CA', debtorZip: '93301', caseNumber: '25CLB01343' },
            dates: { served: '2026-03-17' },
            evidence: { 'dates.served': 'On 03/17/2026 at 6:12 PM I personally delivered' },
            events: [{ type: 'service', title: 'Personal service on defendant', date: '2026-03-17' }]
        };
    }
    if (/diligence/i.test(file)) {
        return { ...base, documentType: 'Declaration of Diligence', documentDate: '2026-03-19', dates: { served: '2026-03-18' }, evidence: { 'dates.served': 'served on March 18, 2026' }, events: [{ type: 'service', title: 'Personal service on defendant', date: '2026-03-17' }] };
    }
    if (/payoff/i.test(file)) {
        return { ...base, documentType: 'Payoff Statement', documentDate: '2025-10-17', fields: { payoffBalance: '19,000.55', principal: '17,200.00', interestRate: '7.99%', accountNumber: '3928004' }, evidence: { payoffBalance: 'Payoff amount: $19,000.55' } };
    }
    return { ...base, documentType: 'Correspondence', documentDate: '2026-02-01' };
}

if (require.main === module) {
    const port = Number(process.env.MOCK_PORT || process.argv[2] || 4567);
    const app = createMock({ log: process.argv[3] || null });
    app.port = port;
    app.listen(port, () => console.log(`mock gemini on ${port}`));
}

module.exports = { createMock, reading };
