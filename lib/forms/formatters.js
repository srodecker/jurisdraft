// ============================================================
// Formats a field name can ask for: [FACT:FORMAT] or [FACT:FORMAT:FORMAT]
// Each takes a value (string, date string, number, object or list) and returns text.
// Adding a format here makes it available on every form.
// ============================================================

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SUFFIX_RE = /,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i;
const NUM_WORDS = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE', 6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE', 10: 'TEN' };

function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) return new Date(Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]));
    const d = new Date(s);
    return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
}

// Same rules as the original engine: capitalise each word, keep small words lower, force LLP/LLC/… upper
function titleCase(s) {
    const small = ['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with'];
    const acronyms = ['LLP', 'LLC', 'PC', 'USA', 'INC', 'LTD', 'CORP'];
    return String(s).toLowerCase().split(/\s+/)
        .map((w, i) => (i > 0 && small.includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .map(w => { const c = w.replace(/[^a-zA-Z0-9]/g, '').toUpperCase(); return acronyms.includes(c) ? c : w; })
        .join(' ');
}

function bareName(v) { return String(v || '').replace(SUFFIX_RE, '').trim(); }
function cityStateZip(a) { return [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); }
function asList(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function esq(name) { const n = String(name || '').replace(/,?\s*Esq\.?$/i, '').trim(); return n ? `${n}, Esq.` : ''; }

const FORMATS = {
    // ---- text ----
    UPPER: v => String(v).toUpperCase(),
    TITLE: v => titleCase(v),
    // ---- dates ----
    LONG: v => { const d = toDate(v); return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : String(v); },     // October 28, 2025
    SHORT: v => { const d = toDate(v); return d ? `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : String(v); }, // Oct 28, 2025
    MDY: v => { const d = toDate(v); return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : String(v); },           // 10/28/2025
    MDYY: v => { const d = toDate(v); return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}` : String(v); }, // 10/28/25
    // ---- money / numbers ----
    MONEY: v => { const n = toNumber(v); return n === null ? String(v) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, // 18,450.22
    DOLLARS: v => { const n = toNumber(v); return n === null ? String(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
    PLAIN: v => { const n = toNumber(v); return n === null ? String(v) : n.toFixed(2); },               // 18450.22
    WORDS: v => { const n = parseInt(v, 10); return NUM_WORDS[n] ? `${n} (${NUM_WORDS[n]})` : String(v); }, // 1 (ONE)
    LAST4: v => String(v).replace(/\D/g, '').slice(-4),
    // ---- parties ----
    NAME: v => bareName(v),                                                                 // drops ", an individual"
    ET_AL: v => `${bareName(v)}, et al.`,
    INDIVIDUAL: v => `${bareName(v)}, an individual`,
    DOES: v => `${bareName(v)}, an individual; and DOES 1 through 10, inclusive`,
    WITH_ROLE: v => `Plaintiff, ${titleCase(bareName(v))}`,
    // ---- addresses (value is an object {name, street, city, state, zip}) ----
    STREET: v => (typeof v === 'object' ? v.street : String(v)) || '',
    CITY_STATE_ZIP: v => (typeof v === 'object' ? cityStateZip(v) : String(v)),
    ONE_LINE: v => typeof v === 'object' ? [v.street, cityStateZip(v)].filter(Boolean).join(', ') : String(v),
    NAME_ADDRESS: v => typeof v === 'object' ? [bareName(v.name), v.street, cityStateZip(v)].filter(Boolean).join('\n') : String(v),
    INDIVIDUAL_ADDRESS: v => typeof v === 'object' ? [`${bareName(v.name)}, an individual`, v.street, cityStateZip(v)].filter(Boolean).join('\n') : String(v),
    SERVICE_LINE: v => typeof v === 'object' ? `${bareName(v.name)}, ${abbrevStreet(v.street || '')}, ${cityStateZip(v)}` : String(v),
    // ---- attorneys (value is a list of {name, sbn, email}) ----
    NAME_SBN: v => asList(v).map(a => (a.sbn ? `${esq(a.name)}, SBN ${a.sbn}` : esq(a.name))).filter(Boolean).join('; '),
    NAME_SBN_COLON: v => asList(v).map(a => (a.sbn ? `${a.name}, SBN: ${a.sbn}` : a.name)).filter(Boolean).join('; '),
    ESQ: v => asList(v).map(a => esq(typeof a === 'object' ? a.name : a)).filter(Boolean).join('; '),
    EMAILS: v => asList(v).map(a => (typeof a === 'object' ? a.email : a)).filter(Boolean).join(', '),
    NAMES: v => asList(v).map(a => (typeof a === 'object' ? a.name : a)).filter(Boolean).join('; '),
    // ---- render hint (handled by the engine, value unchanged) ----
    BOLD: v => v
};

function abbrevStreet(s) {
    return ['St', 'Dr', 'Ter', 'Pl', 'Blvd', 'Ave', 'Rd', 'Ln', 'Ct', 'Cir', 'Pkwy'].reduce((acc, suf) => acc.replace(new RegExp(`\\b${suf}\\b(?!\\.)`, 'g'), suf + '.'), s);
}

// Text for a value when the field asked for no format (lists and addresses need a sensible default)
function plain(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(plain).filter(Boolean).join('; ');
    if (typeof v === 'object') return v.name !== undefined && !v.street ? String(v.name || '') : FORMATS.ONE_LINE(v);
    return String(v);
}

// Format implied by the form itself (Acrobat format scripts on the field), e.g. AFDate_FormatEx("mmmm d, yyyy")
function formatFromScript(script) {
    if (!script) return null;
    const date = script.match(/AFDate_Format(?:Ex)?\(\s*"([^"]+)"/);
    if (date) {
        const f = date[1];
        if (/mmmm/.test(f)) return 'LONG';
        if (/mmm/.test(f)) return 'SHORT';
        if (/yyyy/.test(f)) return 'MDY';
        return 'MDYY';
    }
    const num = script.match(/AFNumber_Format\(\s*(\d+)\s*,\s*(\d)/);
    if (num) return num[1] === '2' ? (num[2] === '0' ? 'MONEY' : 'PLAIN') : null;
    if (/toUpperCase\(\)/.test(script)) return 'UPPER';
    return null;
}

module.exports = { FORMATS, plain, formatFromScript, toDate, toNumber, titleCase, bareName };
