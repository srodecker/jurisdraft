// ============================================================
// Build a case's facts from the per-document readings — no AI call.
// Each read document contributes candidate values (fields, dates, events, hearings).
// For every fact the most credible source wins; real disagreements become conflicts
// the user resolves once (stored as a fact override).
// ============================================================
const { parseDate, isoDate } = require('./case-intel');

// Case fields a document reading can supply (top-level on the matter)
const TEXT_FIELDS = ['debtorName', 'debtorAddress', 'debtorCity', 'debtorState', 'debtorZip',
    'caseNumber', 'courtName', 'courtBranch', 'courtAddress', 'courtCounty', 'creditorName',
    'loanType', 'accountNumber', 'serviceType', 'servedBy', 'serviceAddress', 'defendantResponse'];
const AMOUNT_FIELDS = ['demandAmount', 'judgmentAmount', 'principal', 'interestAmount', 'interestRate',
    'lastPaymentAmount', 'payoffBalance', 'costs', 'attorneyFees'];
const DATE_FIELDS = ['contractDate', 'chargeOffDate', 'lastPaymentDate'];
const CASE_DATES = ['dvnSent', 'responseDue', 'complaintFiled', 'served', 'answerReceived', 'defaultRequested',
    'defaultEntered', 'judgmentEntered', 'abstractFiled', 'abstractRecorded', 'writIssued', 'closed'];

// Dates that record something happening in court — a draft can never prove them
const STATUS_DATES = new Set(['complaintFiled', 'answerReceived', 'defaultRequested', 'defaultEntered',
    'judgmentEntered', 'abstractFiled', 'abstractRecorded', 'writIssued', 'closed']);
// Facts where the newest document is the best evidence
const RECENCY = new Set(['debtorAddress', 'debtorCity', 'debtorState', 'debtorZip', 'payoffBalance',
    'lastPaymentDate', 'lastPaymentAmount', 'defendantResponse']);
// Facts worth asking the user about when sources disagree
const IMPORTANT = new Set(['debtorName', 'caseNumber', 'courtName', 'creditorName', 'demandAmount', 'judgmentAmount',
    'serviceType', 'dates.complaintFiled', 'dates.served', 'dates.defaultRequested', 'dates.defaultEntered', 'dates.judgmentEntered']);
const SERVICE = new Set(['dates.served', 'serviceType', 'servedBy', 'serviceAddress']);
const FINANCIAL = new Set(['principal', 'interestAmount', 'interestRate', 'lastPaymentAmount', 'payoffBalance',
    'contractDate', 'chargeOffDate', 'lastPaymentDate', 'accountNumber', 'loanType']);

const LABELS = {
    debtorName: 'Defendant', debtorAddress: 'Defendant address', debtorCity: 'City', debtorState: 'State', debtorZip: 'ZIP',
    caseNumber: 'Case number', courtName: 'Court', courtBranch: 'Courthouse', courtAddress: 'Courthouse address', courtCounty: 'County',
    creditorName: 'Plaintiff', loanType: 'Loan type', accountNumber: 'Account number', serviceType: 'Service type',
    servedBy: 'Served by', serviceAddress: 'Service address', defendantResponse: 'Defendant response',
    demandAmount: 'Demand amount', judgmentAmount: 'Judgment amount', principal: 'Principal', interestAmount: 'Interest',
    interestRate: 'Interest rate', lastPaymentAmount: 'Last payment amount', payoffBalance: 'Payoff balance', costs: 'Costs',
    attorneyFees: 'Attorney fees', contractDate: 'Contract date', chargeOffDate: 'Charge-off date', lastPaymentDate: 'Last payment date',
    'dates.dvnSent': 'Demand letter sent', 'dates.responseDue': 'Response due', 'dates.complaintFiled': 'Complaint filed',
    'dates.served': 'Served', 'dates.answerReceived': 'Answer filed', 'dates.defaultRequested': 'Default requested',
    'dates.defaultEntered': 'Default entered', 'dates.judgmentEntered': 'Judgment entered', 'dates.abstractFiled': 'Abstract filed',
    'dates.abstractRecorded': 'Abstract recorded', 'dates.writIssued': 'Writ issued', 'dates.closed': 'Closed'
};

function isDraft(doc) {
    const a = doc.analysis || {};
    if (a.isDraft === true) return true;
    return /\bdraft\b|\bshell\b|template|unsigned/i.test(`${doc.fileName} ${a.documentType || ''}`);
}

function isFiled(doc) {
    const a = doc.analysis || {};
    if (a.filedWithCourt === true) return true;
    return /\bfiled\b|conformed|endorsed/i.test(doc.fileName);
}

// How much a document's word counts for a given fact
function sourceWeight(doc, key) {
    const a = doc.analysis || {};
    const type = String(a.documentType || '').toLowerCase();
    const name = String(doc.fileName || '').toLowerCase();
    const draft = isDraft(doc);
    if (draft && (key.startsWith('dates.') && STATUS_DATES.has(key.slice(6)))) return 0;
    let w;
    if (draft) w = 0.25;
    else if (isFiled(doc)) w = 1;
    else if (/proof of service|pos-010|declaration of (diligence|service)/.test(type + ' ' + name)) w = 0.9;
    else if (/complaint|summons|judgment|minute|order|notice|abstract|writ|default|ruling|clerk/.test(type)) w = 0.85;
    else if (/statement|payoff|transaction|agreement|contract|application|credit report|history/.test(type + ' ' + name)) w = 0.75;
    else if (/declaration|request/.test(type)) w = 0.7;
    else if (/email|correspondence|letter|report|confirmation|notice of/.test(type + ' ' + name)) w = 0.55;
    else w = 0.6;

    if (SERVICE.has(key)) {
        if (/proof of service|pos-010/.test(type + ' ' + name)) w *= 1.4;
        else if (/diligence|process serv|service of process/.test(type + ' ' + name)) w *= 1.15;
    }
    if (FINANCIAL.has(key) && /statement|payoff|transaction|agreement|contract|history/.test(type + ' ' + name)) w *= 1.4;
    if (key === 'demandAmount' && /complaint/.test(type)) w *= 1.5;
    if (key === 'judgmentAmount' && /judgment/.test(type)) w *= 1.5;
    if ((key === 'caseNumber' || key.startsWith('court')) && /complaint|summons|judgment|minute|order|notice|default|filed/.test(type + ' ' + name)) w *= 1.2;
    return w;
}

// ---- value normalisation ----
function normDate(v) { const d = parseDate(v); return d ? isoDate(d) : null; }
function normAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) && n !== 0 ? (Math.round(n * 100) / 100).toFixed(2) : null;
}
function normText(key, v) {
    if (v === null || v === undefined) return null;
    let s = String(v).replace(/\s+/g, ' ').trim();
    if (!s || /^(n\/?a|none|unknown|not (stated|found|provided)|-+)$/i.test(s)) return null;
    if (key === 'serviceType') {
        if (/sub/i.test(s)) return 'substituted';
        if (/personal/i.test(s)) return 'personal';
        if (/post|publication|mail/i.test(s)) return s.toLowerCase();
    }
    if (key === 'caseNumber') s = s.toUpperCase().replace(/\s+/g, '');
    if (key === 'debtorState' && s.length > 2 && /california/i.test(s)) s = 'CA';
    return s;
}
// Comparison key: case/punctuation-insensitive
function cmpKey(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function tokens(s) { return new Set(cmpKey(s).split(' ').filter(t => t.length > 1)); }
// "Erick Acevedo" and "Erick Alonso Acevedo" describe the same thing
function sameValue(a, b, key = '') {
    if (cmpKey(a) === cmpKey(b)) return true;
    const bare = key.startsWith('dates.') ? key.slice(6) : key;
    if (key.startsWith('dates.') || DATE_FIELDS.includes(bare) || AMOUNT_FIELDS.includes(bare) || ['caseNumber', 'debtorZip', 'debtorState', 'serviceType', 'accountNumber'].includes(bare)) return false;
    const ta = tokens(a), tb = tokens(b);
    if (!ta.size || !tb.size) return false;
    const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    for (const t of small) if (!big.has(t)) return false;
    return small.size >= 2 || small.size === big.size;
}

function normalize(key, value) {
    const bare = key.startsWith('dates.') ? key.slice(6) : key;
    if (key.startsWith('dates.') || DATE_FIELDS.includes(bare)) return normDate(value);
    if (AMOUNT_FIELDS.includes(bare)) return bare === 'interestRate' ? normText(bare, value) : normAmount(value);
    return normText(bare, value);
}

// Candidate values one document offers: [{key, value, quote}]
function candidatesFrom(doc) {
    const a = doc.analysis || {};
    const ev = a.evidence || {};
    const out = [];
    const fields = a.fields || {};
    for (const f of [...TEXT_FIELDS, ...AMOUNT_FIELDS, ...DATE_FIELDS]) {
        const v = normalize(f, fields[f]);
        if (v) out.push({ key: f, value: v, quote: ev[f] || null });
    }
    const dates = a.dates || {};
    for (const d of CASE_DATES) {
        const v = normDate(dates[d]);
        if (v) out.push({ key: `dates.${d}`, value: v, quote: ev[`dates.${d}`] || ev[d] || null });
    }
    // v1 readings put serviceType under dates
    if (!fields.serviceType && dates.serviceType) {
        const v = normText('serviceType', dates.serviceType);
        if (v) out.push({ key: 'serviceType', value: v, quote: ev.serviceType || null });
    }
    return out;
}

function docDate(doc) {
    return normDate(doc.analysis && doc.analysis.documentDate) || String(doc.createdAt || '').slice(0, 10);
}

// Merge every read document into facts. docs: [{id, fileName, createdAt, analysis}] with analysis.status === 'done'
function mergeFacts(docs, { overrides = {} } = {}) {
    const byKey = new Map();
    for (const doc of docs) {
        for (const c of candidatesFrom(doc)) {
            const w = sourceWeight(doc, c.key);
            if (w <= 0) continue;
            if (!byKey.has(c.key)) byKey.set(c.key, []);
            const groups = byKey.get(c.key);
            let g = groups.find(x => sameValue(x.value, c.value, c.key));
            if (!g) { g = { value: c.value, score: 0, sources: [], latest: '' }; groups.push(g); }
            // Keep the most complete spelling ("Erick Alonso Acevedo" over "Erick Acevedo")
            if (String(c.value).length > String(g.value).length && !c.key.startsWith('dates.')) g.value = c.value;
            g.score += w;
            const dd = docDate(doc);
            if (dd > g.latest) g.latest = dd;
            g.sources.push({ docId: doc.id, fileName: doc.fileName, quote: c.quote, weight: w, date: dd, draft: isDraft(doc) });
        }
    }

    const fields = {};
    const dates = {};
    const sources = {};
    const conflicts = [];
    for (const [key, groups] of byKey) {
        const credible = groups.filter(g => g.sources.some(s => !s.draft)).length ? groups.filter(g => g.sources.some(s => !s.draft)) : groups;
        let ranked;
        if (RECENCY.has(key)) {
            ranked = [...credible].sort((a, b) => (b.latest.localeCompare(a.latest)) || (b.score - a.score));
        } else {
            ranked = [...credible].sort((a, b) => (b.score - a.score) || b.latest.localeCompare(a.latest));
        }
        const win = ranked[0];
        const best = [...win.sources].sort((a, b) => b.weight - a.weight)[0];
        if (key.startsWith('dates.')) dates[key.slice(6)] = win.value;
        else fields[key] = win.value;
        sources[key] = { docId: best.docId, fileName: best.fileName, quote: best.quote || null, count: win.sources.length };

        const runner = ranked[1];
        if (runner && IMPORTANT.has(key) && overrides[key] === undefined
            && !RECENCY.has(key)
            && runner.sources.some(s => !s.draft && s.weight >= 0.6)
            && runner.score >= win.score * 0.5) {
            conflicts.push({
                field: key,
                label: LABELS[key] || key,
                chosen: win.value,
                options: ranked.slice(0, 4).map(g => ({
                    value: g.value,
                    sources: g.sources.map(s => ({ docId: s.docId, fileName: s.fileName, quote: s.quote }))
                }))
            });
        }
    }
    return { fields, dates, sources, conflicts, events: mergeEvents(docs), hearings: mergeHearings(docs) };
}

const EVENT_TYPE_IDS = new Set(['filing', 'hearing', 'service', 'correspondence', 'minute_order', 'court_order', 'payment', 'note', 'discovery', 'deadline', 'status_change']);

function similarTitle(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.size || !tb.size) return false;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return shared / Math.min(ta.size, tb.size) >= 0.5;
}

function mergeEvents(docs) {
    const out = [];
    for (const doc of docs) {
        const draft = isDraft(doc);
        for (const e of (doc.analysis && doc.analysis.events) || []) {
            const date = normDate(e.date);
            if (!date || !e.title) continue;
            // A draft can't prove a filing or order happened
            if (draft && /filing|order|minute|service/.test(e.type || '')) continue;
            const type = EVENT_TYPE_IDS.has(e.type) ? e.type : 'note';
            const dup = out.find(x => x.date === date && (x.type === type || similarTitle(x.title, e.title)) && similarTitle(x.title, e.title));
            if (dup) {
                if (!dup.sources.includes(doc.fileName)) dup.sources.push(doc.fileName);
                if (!dup.description && e.description) dup.description = e.description;
                continue;
            }
            out.push({ type, title: String(e.title).slice(0, 200), date, description: e.description ? String(e.description).slice(0, 1000) : '', sources: [doc.fileName], docId: doc.id });
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

function mergeHearings(docs) {
    const out = [];
    const ordered = [...docs].sort((a, b) => docDate(a).localeCompare(docDate(b)));
    for (const doc of ordered) {
        if (isDraft(doc)) continue;
        for (const h of (doc.analysis && doc.analysis.hearings) || []) {
            const date = normDate(h.date);
            if (!date) continue;
            const type = String(h.type || 'Hearing').slice(0, 120);
            const dup = out.find(x => x.date === date && (similarTitle(x.type, type) || !x.type || !type));
            if (dup) {
                // Later documents update the status (continued / vacated / held)
                if (h.status) dup.status = h.status;
                if (h.time && !dup.time) dup.time = h.time;
                if (h.department && !dup.department) dup.department = h.department;
                if (!dup.sources.includes(doc.fileName)) dup.sources.push(doc.fileName);
                continue;
            }
            out.push({ type, date, time: h.time || null, department: h.department || null, judge: h.judge || null, location: h.location || null, status: h.status || 'Scheduled', sources: [doc.fileName] });
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { mergeFacts, candidatesFrom, sourceWeight, isDraft, LABELS, TEXT_FIELDS, AMOUNT_FIELDS, DATE_FIELDS, CASE_DATES };
