// ============================================================
// The fact dictionary — every piece of information a form can ask for, defined once.
//
// A form field named [FACT] or [FACT:FORMAT] gets the fact's value (formatted).
// A checkbox named [CHECK:CONDITION] is checked when the condition is true.
//
// Each fact says where its value comes from, in priority order:
//   1. values read from the case documents (legacy bracket keys from extraction, e.g. [PLAINTIFF_NAME])
//   2. the case's merged facts (matter fields)
//   3. the firm settings (firm + attorneys)
// `extract` describes the fact for the AI that reads documents.
// ============================================================
const { FORMATS, toNumber, titleCase } = require('./formatters');

const empty = v => v === undefined || v === null || String(v).trim() === '' || v === 'null';
function first(...vals) { for (const v of vals) if (!empty(v)) return typeof v === 'string' ? v.trim() : v; return ''; }
const stripEsq = n => String(n || '').replace(/(,\s*)?Esq\.?$/i, '').trim().replace(/,$/, '');

// ---------- context: everything the facts can draw on ----------
// matter: Kinecta case (optional) · fd: bracket-key values from document extraction (optional)
// profile: signed-in user's profile (firm, attorneys) · today: Date
// signer: index of the attorney who signs (from learned preferences); default the second, else the first
function buildContext({ matter = {}, fd = {}, profile = {}, today = new Date(), signer } = {}) {
    const m = matter || {};
    const d = m.dates || {};
    const firm = (profile && profile.firm) || {};
    const patts = (profile && profile.attorneys) || [];
    const atty = i => {
        const sfx = i === 0 ? '' : String(i + 1);
        const p = patts[i] || {};
        const a = { name: stripEsq(first(fd[`[ATTY_NAME${sfx}]`], p.name)), sbn: first(fd[`[ATTY_SBN${sfx}]`], p.sbn), email: first(fd[`[ATTY_EMAIL${sfx}]`], p.email) };
        return a.name ? a : null;
    };
    const attorneys = [atty(0), atty(1), atty(2)].filter(Boolean);
    const signs = attorneys[signer >= 0 ? signer : 1] || attorneys[1] || attorneys[0] || '';
    return { m, d, fd, firm, attorneys, signer: signs, today };
}

// ---------- facts ----------
const F = {};
const fact = (key, label, type, get, extract = '') => { F[key] = { key, label, type, get, extract }; };

// Parties
fact('PLAINTIFF', 'Plaintiff', 'name', c => first(c.fd['[PLAINTIFF_NAME]'], c.m.creditorName), 'Plaintiff exactly as named in the complaint caption.');
fact('DEFENDANT', 'Defendant', 'name', c => first(c.fd['[DEFENDANT_NAME]'], c.fd['[DEBTOR1_NAME]'], c.m.debtorName), 'Defendant / debtor full name as in the complaint caption.');
fact('DEFENDANT_ADDRESS', 'Defendant address', 'address', c => {
    const street = first(c.fd['[DEBTOR1_ADDRESS]'], c.m.debtorAddress).replace(/,\s*$/, '');
    const a = { name: F.DEFENDANT.get(c), street: street ? titleCase(street) : '', city: titleCase(first(c.fd['[DEBTOR1_CITY]'], c.m.debtorCity)), state: first(c.fd['[DEBTOR1_STATE]'], c.m.debtorState), zip: first(c.fd['[DEBTOR1_ZIP]'], c.m.debtorZip) };
    return a.street || a.city ? a : '';
}, 'Defendant mailing/service address: street only, then city, state, ZIP.');
fact('DEFENDANT_STREET', 'Defendant street', 'text', c => (F.DEFENDANT_ADDRESS.get(c) || {}).street || '');
fact('DEFENDANT_CITY', 'Defendant city', 'text', c => (F.DEFENDANT_ADDRESS.get(c) || {}).city || '');
fact('DEFENDANT_STATE', 'Defendant state', 'text', c => (F.DEFENDANT_ADDRESS.get(c) || {}).state || '');
fact('DEFENDANT_ZIP', 'Defendant ZIP', 'text', c => (F.DEFENDANT_ADDRESS.get(c) || {}).zip || '');
fact('DEFENDANT_DL_LAST4', 'Defendant driver license (last 4)', 'text', c => FORMATS.LAST4(first(c.fd['[DEBTOR1_DL_LAST4]'])), 'Last 4 digits of the driver license only.');
fact('DEFENDANT_SS_LAST4', 'Defendant SSN (last 4)', 'text', c => FORMATS.LAST4(first(c.fd['[DEBTOR1_SS_LAST4]'])), 'Last 4 digits of the SSN only.');
fact('CREDITOR', 'Judgment creditor', 'name', c => first(c.fd['[CREDITOR1_NAME]'], F.PLAINTIFF.get(c)));
fact('CREDITOR_ADDRESS', 'Creditor address', 'address', c => {
    const a = { name: F.CREDITOR.get(c), street: first(c.fd['[CREDITOR_ADDRESS]']), city: first(c.fd['[CREDITOR_CITY]']), state: first(c.fd['[CREDITOR_STATE]']), zip: first(c.fd['[CREDITOR_ZIP]']) };
    return a.street ? a : '';
}, "Creditor's own mailing address from its letterhead (not the attorney's or the court's).");
fact('CASE_NAME', 'Case name', 'text', c => {
    const p = F.PLAINTIFF.get(c), d = F.DEFENDANT.get(c);
    return p && d ? `${titleCase(p)} v. ${titleCase(FORMATS.NAME(d))}, et al.` : '';
});

// Case and court
fact('CASE_NUMBER', 'Case number', 'text', c => first(c.fd['[CASE_NUMBER]'], c.m.caseNumber), 'Court case number.');
fact('COURT_COUNTY', 'Court county', 'text', c => first(c.fd['[COURT_COUNTY]'], c.m.courtCounty), 'County of the superior court.');
fact('COURT_BRANCH', 'Courthouse name', 'text', c => first(c.fd['[COURT_BRANCH_NAME]'], c.m.courtBranch), 'Courthouse / branch name in the caption.');
fact('COURT_STREET', 'Court street address', 'text', c => first(c.fd['[COURT_STREET_ADDRESS]'], splitCourt(c.m.courtAddress).street));
fact('COURT_CITY_ZIP', 'Court city and ZIP', 'text', c => first(c.fd['[COURT_CITY_ZIP]'], splitCourt(c.m.courtAddress).cityZip));
fact('COURT_MAILING', 'Court mailing address', 'text', c => {
    const street = F.COURT_STREET.get(c);
    const mail = first(c.fd['[COURT_MAILING_ADDRESS]']);
    // Rule: blank or identical to the street address → "Same as street address"
    if (!mail || mail.toLowerCase().trim() === String(street).toLowerCase().trim()) return street ? 'Same as street address' : '';
    return mail;
});
fact('COURT_INFO', 'Court name and address', 'text', c => [F.COURT_STREET.get(c), F.COURT_CITY_ZIP.get(c)].filter(Boolean).join(', '));
fact('NUMBER_OF_CAUSES', 'Number of causes of action', 'number', c => first(c.fd['[NUMBER_OF_CAUSES]']), 'Number of causes of action in the complaint.');

// Dates
fact('TODAY', 'Date signed (today)', 'date', c => c.today);
fact('COMPLAINT_FILED', 'Complaint filed', 'date', c => first(c.d.complaintFiled, c.fd['[COMPLAINT_FILED]']), 'Date the complaint was filed (file stamp).');
fact('SERVED', 'Date served', 'date', c => first(c.d.served));
fact('DEFAULT_REQUESTED', 'Default requested', 'date', c => first(c.d.defaultRequested));
fact('DEFAULT_ENTERED', 'Default entered', 'date', c => first(c.d.defaultEntered));
fact('JUDGMENT_ENTERED', 'Judgment entered', 'date', c => first(c.d.judgmentEntered, c.fd['[JUDGMENT_ENTRY_DATE]']), 'Date judgment was entered.');
fact('STAY_ENFORCEMENT_DATE', 'Enforcement stayed until', 'date', c => first(c.fd['[STAY_ENFORCEMENT_DATE]']));

// Amounts
fact('DEMAND_AMOUNT', 'Amount demanded', 'money', c => first(c.fd['[DEMAND_AMOUNT]'], c.m.demandAmount), 'Amount demanded in the complaint prayer (not the payoff).');
fact('JUDGMENT_AMOUNT', 'Judgment amount', 'money', c => first(c.fd['[JUDGMENT_TOTAL_AMOUNT]'], c.m.judgmentAmount), 'Total judgment amount, only if a judgment was entered.');
fact('PRINCIPAL', 'Principal', 'money', c => first(c.m.principal));
fact('INTEREST', 'Interest', 'money', c => first(c.m.interestAmount));
fact('COSTS', 'Costs', 'money', c => first(c.fd['[COSTS]'], c.m.costs));
fact('ATTORNEY_FEES', 'Attorney fees', 'money', c => first(c.fd['[ATTY_FEES]'], c.m.attorneyFees));
fact('PAYOFF_BALANCE', 'Payoff balance', 'money', c => first(c.m.payoffBalance));
fact('ACCOUNT_NUMBER', 'Account number', 'text', c => first(c.m.accountNumber));

// Firm and attorneys
fact('FIRM_NAME', 'Firm name', 'name', c => first(c.fd['[FIRM_NAME]'], c.firm.name));
fact('FIRM_STREET', 'Firm street', 'text', c => first(c.fd['[FIRM_ADDRESS]'], c.firm.address));
fact('FIRM_CITY', 'Firm city', 'text', c => first(c.fd['[FIRM_CITY]'], c.firm.city));
fact('FIRM_STATE', 'Firm state', 'text', c => first(c.fd['[FIRM_STATE]'], c.firm.state));
fact('FIRM_ZIP', 'Firm ZIP', 'text', c => first(c.fd['[FIRM_ZIP]'], c.firm.zip));
fact('FIRM_PHONE', 'Firm phone', 'text', c => first(c.fd['[FIRM_PHONE]'], c.firm.phone));
fact('FIRM_FAX', 'Firm fax', 'text', c => first(c.fd['[FIRM_FAX]'], c.firm.fax));
fact('FIRM_ADDRESS', 'Firm address', 'address', c => {
    const a = { name: F.FIRM_NAME.get(c), street: F.FIRM_STREET.get(c), city: F.FIRM_CITY.get(c), state: F.FIRM_STATE.get(c), zip: F.FIRM_ZIP.get(c) };
    return a.street || a.city ? a : '';
});
fact('SIGNER', 'Signing attorney', 'list', c => c.signer || '', 'The attorney who signs the form (chosen once, then remembered).');
fact('ATTORNEYS', 'Attorneys', 'list', c => (c.attorneys.length ? c.attorneys : ''), 'Every attorney in the caption block, in order, with State Bar number and email.');
for (const i of [1, 2]) {
    fact(`ATTORNEY_${i}`, `Attorney ${i}`, 'list', c => c.attorneys[i - 1] || '');
    fact(`ATTORNEY_${i}_NAME`, `Attorney ${i} name`, 'name', c => (c.attorneys[i - 1] || {}).name || '');
    fact(`ATTORNEY_${i}_SBN`, `Attorney ${i} State Bar #`, 'text', c => (c.attorneys[i - 1] || {}).sbn || '');
    fact(`ATTORNEY_${i}_EMAIL`, `Attorney ${i} email`, 'text', c => (c.attorneys[i - 1] || {}).email || '');
}

function splitCourt(addr) {
    const m = String(addr || '').match(/^(.+?),\s*([^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\s*$/);
    return m ? { street: m[1], cityZip: m[2] } : { street: '', cityZip: '' };
}

// ---------- checkbox conditions: [CHECK:NAME] ----------
const amountForCaseType = c => toNumber(first(F.DEMAND_AMOUNT.get(c), F.JUDGMENT_AMOUNT.get(c)));
const isAssignee = c => /assignee|successor|buyer/i.test(`${F.PLAINTIFF.get(c)} ${F.CREDITOR.get(c)}`);
const yes = v => v === true || String(v).toLowerCase() === 'true';
const CONDITIONS = {
    ALWAYS: { label: 'Always checked', test: () => true },
    LIMITED_CIVIL: { label: 'Limited civil (≤ $35,000)', test: c => { const n = amountForCaseType(c); return n !== null && n <= 35000; } },
    UNLIMITED_CIVIL: { label: 'Unlimited civil (> $35,000)', test: c => { const n = amountForCaseType(c); return n !== null && n > 35000; } },
    BREACH_OF_CONTRACT: { label: 'Breach of contract case', test: c => yes(c.fd['[RAW_IS_BREACH_OF_CONTRACT]']) },
    JUDGMENT_CREDITOR: { label: 'Plaintiff is the judgment creditor', test: c => !isAssignee(c) },
    ASSIGNEE_OF_RECORD: { label: 'Plaintiff is an assignee of record', test: c => isAssignee(c) },
    ATTORNEY_FOR_CREDITOR: { label: 'Filed by the attorney for the creditor', test: c => yes(first(c.fd['[IS_ATTORNEY_FOR_CREDITOR]'], true)) },
    DL_UNKNOWN: { label: "Defendant's driver license unknown", test: c => !F.DEFENDANT_DL_LAST4.get(c) },
    SS_UNKNOWN: { label: "Defendant's SSN unknown", test: c => !F.DEFENDANT_SS_LAST4.get(c) },
    STAY_NOT_ORDERED: { label: 'No stay of enforcement ordered', test: c => !F.STAY_ENFORCEMENT_DATE.get(c) },
    PERSONAL_SERVICE: { label: 'Personally served', test: c => /personal/i.test(first(c.m.serviceType, c.d.serviceType)) },
    SUBSTITUTED_SERVICE: { label: 'Served by substituted service', test: c => /sub/i.test(first(c.m.serviceType, c.d.serviceType)) }
};

module.exports = { FACTS: F, CONDITIONS, buildContext, first, empty };
