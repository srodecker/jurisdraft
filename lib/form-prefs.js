// ============================================================
// Form preferences the system learns by asking.
// When a form has a choice the documents can't settle (two attorneys: who signs? a nickname in
// quotes: keep it?), filling stops and returns the question. The answer can be remembered in the
// user's settings (formPrefs), and from then on it is applied without asking.
// A remembered answer that no longer fits the case (that attorney isn't on it) is asked again.
// ============================================================

const NICKNAME_RE = /\s*["\u201c\u201d][^"\u201c\u201d]+["\u201c\u201d]\s*/g;
const HAS_NICKNAME = /["\u201c\u201d][^"\u201c\u201d]+["\u201c\u201d]/;
const ATTY_KEYS = ['[ATTY_NAME]', '[ATTY_NAME2]'];

const clean = n => String(n || '').replace(/,?\s*Esq\.?$/i, '').trim();
// Who an attorney is, regardless of nickname or "Esq.": their last name
const personKey = n => clean(n).replace(NICKNAME_RE, ' ').trim().split(/\s+/).pop().toLowerCase();

function attorneysIn(data) {
    return ATTY_KEYS.map((k, i) => ({ index: i, key: k, name: clean(data[k]), sbn: String(data[i ? '[ATTY_SBN2]' : '[ATTY_SBN]'] || '').trim() }))
        .filter(a => a.name);
}

const DECISIONS = [
    {
        id: 'nicknames',
        when: data => attorneysIn(data).some(a => HAS_NICKNAME.test(a.name)),
        question: data => {
            const a = attorneysIn(data).find(x => HAS_NICKNAME.test(x.name));
            return `An attorney name has a nickname in quotes: ${a.name}. Keep it on forms?`;
        },
        options: data => {
            const a = attorneysIn(data).find(x => HAS_NICKNAME.test(x.name));
            return [
                { value: 'drop', label: `No: ${a.name.replace(NICKNAME_RE, ' ').replace(/\s+/g, ' ').trim()}` },
                { value: 'keep', label: `Yes: ${a.name}` }
            ];
        },
        fallback: () => 'keep',
        apply: (data, v) => {
            if (v !== 'drop') return;
            for (const k of ATTY_KEYS) if (data[k]) data[k] = String(data[k]).replace(NICKNAME_RE, ' ').replace(/\s+/g, ' ').trim();
        }
    },
    {
        id: 'signer',
        when: data => attorneysIn(data).length > 1,
        question: () => 'Two attorneys are on this case. Who signs the forms?',
        options: data => attorneysIn(data).map(a => ({ value: personKey(a.name), label: a.name })),
        fallback: data => personKey(attorneysIn(data).slice(-1)[0].name), // the original behaviour: the second attorney
        apply: () => {} // used after the form text is built (applySigner / signerIndex)
    }
];

// Settle every decision for this data. prefs: remembered answers; answers: given with this request.
// Returns { data, chosen, questions }. With ask=false, an open question takes its fallback instead.
function decide(input, prefs = {}, answers = {}, ask = false) {
    const data = { ...input };
    const chosen = {}, questions = [];
    for (const d of DECISIONS) {
        if (!d.when(data)) continue;
        const options = d.options(data);
        const valid = v => v !== undefined && v !== null && options.some(o => o.value === v);
        let v = valid(answers[d.id]) ? answers[d.id] : valid(prefs[d.id]) ? prefs[d.id] : undefined;
        if (v === undefined) {
            if (ask) { questions.push({ id: d.id, question: d.question(data), options }); continue; }
            v = d.fallback(data);
        }
        chosen[d.id] = v;
        d.apply(data, v);
    }
    return { data, chosen, questions };
}

// Which attorney (0 or 1) signs, from the chosen key
function signerIndex(data, chosen) {
    const list = attorneysIn(data);
    if (!list.length) return -1;
    const hit = list.find(a => personKey(a.name) === chosen.signer);
    return hit ? hit.index : list[list.length - 1].index;
}

// Original form engine: the signature-line variables follow the chosen signer
function applySigner(data, chosen) {
    if (!chosen.signer) return data;
    const list = attorneysIn(data);
    const a = list.find(x => personKey(x.name) === chosen.signer);
    if (!a) return data;
    data['[VAR_ATTY_NAME2]'] = `${a.name}, Esq.`;
    data['[VAR_ATTY2_NAME]'] = a.sbn ? `${a.name}, SBN: ${a.sbn}` : a.name;
    data['[VAR_CAPITAL_ATTY_NAME2]'] = a.name.toUpperCase();
    return data;
}

// Answers worth remembering, merged into the saved prefs
function remember(prefs = {}, answers = {}) {
    const out = { ...prefs };
    for (const d of DECISIONS) if (answers[d.id] !== undefined && answers[d.id] !== '') out[d.id] = answers[d.id];
    return out;
}

const LABELS = { nicknames: 'Attorney nicknames in quotes', signer: 'Attorney who signs' };
function describe(prefs = {}) {
    return Object.entries(prefs).filter(([k]) => LABELS[k]).map(([id, value]) => ({
        id, label: LABELS[id],
        value: id === 'nicknames' ? (value === 'drop' ? 'Left off' : 'Kept') : id === 'signer' ? value.replace(/^./, c => c.toUpperCase()) : String(value)
    }));
}

module.exports = { decide, applySigner, signerIndex, remember, describe, attorneysIn, DECISIONS };
