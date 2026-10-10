// ============================================================
// Case intelligence for California consumer-loan collection cases:
// derived stage, deadlines (calculated from case dates), the form catalog,
// and mapping case facts → form variables ([CASE_NUMBER], [DEFENDANT_NAME], …).
// ============================================================
const fs = require('fs');
const path = require('path');

// ---------- dates ----------
const DAY = 24 * 60 * 60 * 1000;

function parseDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    const d = new Date(s);
    return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d) { return d ? d.toISOString().slice(0, 10) : null; }
function addDays(d, n) { return d ? new Date(d.getTime() + n * DAY) : null; }
function addYears(d, n) { if (!d) return null; const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x; }

// Today in California
function todayLA() {
    const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    return parseDate(s);
}

function longDate(d) {
    return d ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : '';
}

// ---------- stage ----------
const STAGES = [
    { key: 'intake', label: 'Pre-filing' },
    { key: 'filed', label: 'Filed — serve defendant' },
    { key: 'served', label: 'Served — answer period' },
    { key: 'default_window', label: 'Request default' },
    { key: 'default_requested', label: 'Default requested' },
    { key: 'default_entered', label: 'Default entered — get judgment' },
    { key: 'judgment', label: 'Judgment entered' },
    { key: 'enforcement', label: 'Post-judgment' }
];

function answerDueDate(matter) {
    const d = matter.dates || {};
    if (d.answerDue) return parseDate(d.answerDue);
    const served = parseDate(d.served);
    if (!served) return null;
    // CCP 412.20: 30 days to respond. Substituted service (CCP 415.20) is complete 10 days after mailing.
    const substituted = /substitut/i.test(d.serviceType || matter.serviceType || '');
    return addDays(served, substituted ? 40 : 30);
}

function computeStage(matter, today = todayLA()) {
    const d = matter.dates || {};
    let key = 'intake';
    let contested = false;
    if (d.closed || matter.status === 'closed') key = 'closed';
    else if (d.writIssued || d.abstractRecorded || d.abstractFiled) key = 'enforcement';
    else if (d.judgmentEntered) key = 'judgment';
    else if (d.defaultEntered) key = 'default_entered';
    else if (d.defaultRequested) key = 'default_requested';
    else if (d.answerReceived) { key = 'served'; contested = true; }
    else if (d.served) {
        const due = answerDueDate(matter);
        key = due && today > due ? 'default_window' : 'served';
    } else if (d.complaintFiled || matter.caseNumber) key = 'filed';

    if (key === 'closed') return { key, label: 'Closed', step: STAGES.length, contested: false };
    const idx = STAGES.findIndex(s => s.key === key);
    return { key, label: contested ? 'Contested — answer filed' : STAGES[idx].label, step: idx, contested };
}

// ---------- deadlines ----------
// Calculated from the case dates; each item says which rule it comes from.
function computeDeadlines(matter, today = todayLA()) {
    const d = matter.dates || {};
    const out = [];
    const add = (key, title, date, rule, done, extra = {}) => {
        if (!date) return;
        const days = Math.round((date - today) / DAY);
        let status = done ? 'done' : days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'upcoming';
        out.push({ key, title, date: isoDate(date), daysAway: days, status, rule, ...extra });
    };

    const filed = parseDate(d.complaintFiled);
    const served = parseDate(d.served);
    const answerDue = answerDueDate(matter);
    const defaultEntered = parseDate(d.defaultEntered);
    const judgment = parseDate(d.judgmentEntered);

    if (filed) add('serve', 'Serve defendant & file proof of service', addDays(filed, 60), 'CRC 3.110(b): within 60 days of filing the complaint', !!served);
    if (served && answerDue) add('answer_due', 'Defendant\'s response due', answerDue,
        /substitut/i.test(d.serviceType || matter.serviceType || '') ? 'CCP 412.20 + 415.20: 30 days after substituted service is complete (10 days after mailing)' : 'CCP 412.20: 30 days after personal service',
        !!(d.answerReceived || d.defaultRequested || d.defaultEntered || judgment) || answerDue < today, { kind: 'info' });
    if (answerDue && !d.answerReceived) add('request_default', 'Request entry of default (CIV-100)', addDays(answerDue, 10), 'CRC 3.110(g): within 10 days after the time to respond has elapsed', !!(d.defaultRequested || defaultEntered || judgment), { form: 'CIV-100 (R4D).pdf' });
    if (defaultEntered) add('default_judgment', 'Obtain default judgment', addDays(defaultEntered, 45), 'CRC 3.110(h): within 45 days after default is entered', !!judgment, { form: 'CIV-100.pdf' });
    if (judgment && !d.abstractRecorded && !d.abstractFiled) add('abstract', 'Prepare abstract of judgment (EJ-001)', addDays(judgment, 30), 'Firm practice: record the abstract promptly after judgment', false, { form: 'EJ-001.pdf' });
    if (judgment) add('renewal', 'Renew judgment (expires in 10 years)', addDays(addYears(judgment, 10), -90), 'CCP 683.020 / 683.130: renew before the 10-year period ends', !!d.judgmentRenewed);

    for (const h of matter.hearings || []) {
        const date = parseDate(h.date);
        if (!date) continue;
        const done = /vacat|held|continued/i.test(h.status || '') || date < today;
        add(`hearing_${h.id || h.date}`, `${h.type || 'Hearing'}${h.time ? ' at ' + h.time : ''}${h.department ? ' — ' + h.department : ''}`, date, 'Court calendar (from case documents)', done, { kind: 'hearing', status_text: h.status || '' });
    }
    for (const c of matter.customDeadlines || []) {
        add(`custom_${c.id}`, c.title, parseDate(c.date), c.notes || 'Added manually', !!c.done, { kind: 'custom', id: c.id });
    }
    const rank = { overdue: 0, soon: 1, upcoming: 2, done: 3 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || a.date.localeCompare(b.date));
}

function nextDeadline(matter, today) {
    return computeDeadlines(matter, today).find(x => x.status !== 'done') || null;
}

// ---------- forms ----------
const FORM_CATALOG = [
    { file: 'SUM-100.pdf', code: 'SUM-100', title: 'Summons', stage: 'Filing', purpose: 'Summons issued with the complaint. Court/courthouse is chosen from the debtor ZIP code.' },
    { file: 'CM-010.pdf', code: 'CM-010', title: 'Civil Case Cover Sheet', stage: 'Filing', purpose: 'Filed with the complaint (limited civil, breach of contract/collections).' },
    { file: 'LASC.pdf', code: 'LACIV 109', title: 'LASC Civil Case Cover Sheet Addendum & Statement of Location', stage: 'Filing', purpose: 'Los Angeles County filings only.' },
    { file: 'CIV-100 (R4D).pdf', code: 'CIV-100', title: 'Request for Entry of Default (clerk\'s default)', stage: 'Default', purpose: 'After the response time expires with no answer. "Entry of default" is pre-checked.' },
    { file: 'CIV-100.pdf', code: 'CIV-100', title: 'Request for Court Judgment (default judgment)', stage: 'Judgment', purpose: 'After default is entered — request court judgment with amounts, costs and fees.' },
    { file: 'POS_Def_Package.docx', code: 'POS', title: 'Proof of Service by Mail — Default Judgment Application', stage: 'Judgment', purpose: 'Word document served with the default judgment package.' },
    { file: 'EJ-001.pdf', code: 'EJ-001', title: 'Abstract of Judgment — Civil and Small Claims', stage: 'Post-judgment', purpose: 'After judgment is entered, to record a judgment lien.' },
    { file: 'CIV-110 (Dismissal).pdf', code: 'CIV-110', title: 'Request for Dismissal — DOES 1–10 only', stage: 'Default', purpose: 'Dismiss the Doe defendants (usually filed with the default judgment request).' },
    { file: 'CIV-110.pdf', code: 'CIV-110', title: 'Request for Dismissal (general)', stage: 'Any', purpose: 'Dismiss the entire action or specific parties (e.g. after payment/settlement).' }
];

function findForm(nameOrCode) {
    const q = String(nameOrCode || '').toLowerCase().trim();
    if (!q) return null;
    return FORM_CATALOG.find(f => f.file.toLowerCase() === q)
        || FORM_CATALOG.find(f => f.file.toLowerCase().replace(/\.(pdf|docx)$/, '') === q)
        || FORM_CATALOG.find(f => q.includes('default') && q.includes('entry') && f.file === 'CIV-100 (R4D).pdf')
        || FORM_CATALOG.find(f => q.includes('does') && f.file === 'CIV-110 (Dismissal).pdf')
        || FORM_CATALOG.find(f => f.code.toLowerCase() === q)
        || FORM_CATALOG.find(f => f.title.toLowerCase().includes(q) || q.includes(f.code.toLowerCase()));
}

// Variables the extraction prompt knows (the canonical "case → form" vocabulary)
let FORM_VARIABLES = [];
try {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'Prompts', 'Extraction_Prompt.txt'), 'utf8');
    FORM_VARIABLES = [...new Set(prompt.slice(prompt.indexOf('SCHEMA')).match(/\[[A-Z0-9_]+\]/g) || [])];
} catch (_) { /* prompt file missing — leave empty */ }

const SPLIT_ADDRESS = /^(.*?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)$/;

// Case facts → form variables. Values from the documents (matter.formData) win;
// structured case fields fill gaps; caller overrides are applied last.
function buildFormData(matter, overrides = {}) {
    const fd = { ...(matter.formData || {}) };
    const set = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '' && !String(fd[k] || '').trim()) fd[k] = v; };
    const d = matter.dates || {};
    let street = matter.debtorAddress || '';
    let city = matter.debtorCity || '';
    let state = matter.debtorState || '';
    let zip = matter.debtorZip || '';
    const m = street.match(SPLIT_ADDRESS);
    if (m && !city) { street = m[1]; city = m[2]; state = m[3]; zip = m[4]; }

    set('[PLAINTIFF_NAME]', matter.creditorName);
    set('[CREDITOR1_NAME]', matter.creditorName);
    set('[DEFENDANT_NAME]', matter.debtorName);
    set('[DEBTOR1_NAME]', matter.debtorName);
    set('[DEBTOR1_ADDRESS]', street);
    set('[DEBTOR1_CITY]', city);
    set('[DEBTOR1_STATE]', state);
    set('[DEBTOR1_ZIP]', zip);
    set('[CASE_NUMBER]', matter.caseNumber);
    set('[COURT_COUNTY]', matter.courtCounty);
    set('[COURT_BRANCH_NAME]', matter.courtBranch);
    set('[DEMAND_AMOUNT]', matter.demandAmount);
    set('[JUDGMENT_TOTAL_AMOUNT]', matter.judgmentAmount);
    set('[COMPLAINT_FILED]', longDate(parseDate(d.complaintFiled)));
    set('[JUDGMENT_ENTRY_DATE]', longDate(parseDate(d.judgmentEntered)));
    set('[AGAINST_DEFENDANT_NAME]', fd['[DEFENDANT_NAME]']);

    fd['[DATE_SIGNED]'] = longDate(todayLA());
    // Filed cases keep the court from their documents instead of re-deriving it from the debtor ZIP
    if (fd['[CASE_NUMBER]'] && fd['[COURT_STREET_ADDRESS]']) fd['[USE_CASE_COURT]'] = true;
    for (const [k, v] of Object.entries(overrides || {})) {
        const key = /^\[.*\]$/.test(k) ? k : `[${String(k).toUpperCase()}]`;
        fd[key] = v;
    }
    return fd;
}

// Empty fields worth asking about (skip page-2 mirrors, signatures and blank misc lines)
function importantMissing(emptyFields) {
    const skip = /^\[(DATE\d*|CREDIT_\d|AMOUNT_\d|AMUONT_\d|BALANCE_\d|FEES\d|OTHER\d?|SPECIFY|NAME\d|PRINT_NAME\d*|CLERK_BY|REASONS|DAILY_DAMAGE|COUNTY_REGISTRATION|REGISTRATION_NO|ASSISTANT_.*|NOTMAILED|OTHER_SPECIFY|.*_P2|CASE_NAME\d|CASE_NUMBER\d|DEBTOR[2-5]_.*|CREDITOR2_.*|ORIGINAL_.*|LIEN_.*|ABSTRACT_CLERK|ABSTRACT_ISSUED_DATE|ENFORCEMENT_ORDERED_DATE|JUDGMENT_RENEWAL_DATE|ATTORNEY_SIGNATURE|COSTS|ATTY_FEES|TOTAL_AMOUNT|VAR_.*)\]$/;
    return emptyFields.filter(f => !skip.test(f));
}

module.exports = {
    STAGES, FORM_CATALOG, FORM_VARIABLES,
    parseDate, isoDate, todayLA, longDate,
    computeStage, computeDeadlines, nextDeadline, answerDueDate,
    findForm, buildFormData, importantMissing
};
