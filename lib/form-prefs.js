// ============================================================
// Form preferences the system learns by asking.
// When a form has a choice the documents can't settle (two attorneys: who signs, who is in the
// caption? a nickname in quotes: keep it?), filling stops and returns the question. The answer can be
// remembered in the user's settings (formPrefs) as their usual; from then on it is applied without
// asking, and every filled form reports the choices it used so one form can be changed in one click.
// A remembered answer that no longer fits the case (that attorney isn't on it) is asked again.
// ============================================================

const NICKNAME_RE = /\s*["\u201c\u201d][^"\u201c\u201d]+["\u201c\u201d]\s*/g;
const HAS_NICKNAME = /["\u201c\u201d][^"\u201c\u201d]+["\u201c\u201d]/;
const ATTY_KEYS = ['[ATTY_NAME]', '[ATTY_NAME2]'];

const clean = n => String(n || '').replace(/,?\s*Esq\.?$/i, '').trim();
// Who an attorney is, regardless of nickname or "Esq.": their last name
const personKey = n => clean(n).replace(NICKNAME_RE, ' ').trim().split(/\s+/).pop().toLowerCase();

function attorneysIn(data) {
    return ATTY_KEYS.map((k, i) => ({
        index: i, key: k, name: clean(data[k]),
        sbn: String(data[i ? '[ATTY_SBN2]' : '[ATTY_SBN]'] || '').trim(),
        email: String(data[i ? '[ATTY_EMAIL2]' : '[ATTY_EMAIL]'] || '').trim()
    })).filter(a => a.name);
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
        normalize: v => (/^(no|drop|remove|leave)/i.test(String(v || '')) ? 'drop' : /^(yes|keep)/i.test(String(v || '')) ? 'keep' : v),
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
        normalize: v => (v ? personKey(v) : v), // a name ("Darius Ghomashchi") works as an answer
        apply: () => {} // used after the form text is built (applyAttorneys / signerIndex)
    },
    {
        id: 'caption',
        when: data => attorneysIn(data).length > 1,
        question: () => 'Which attorneys go in the caption (attorney block at the top)?',
        options: data => [
            { value: 'all', label: `All of them: ${attorneysIn(data).map(a => a.name).join(' and ')}` },
            { value: 'signer', label: 'Only the attorney who signs' }
        ],
        fallback: () => 'all',
        normalize: v => (/^(only|signer|one|just)/i.test(String(v || '')) ? 'signer' : /^(all|both|every)/i.test(String(v || '')) ? 'all' : v),
        apply: () => {}
    }
];

// Settle every decision for this data. prefs: remembered answers; answers: given with this request.
// Returns { data, chosen, questions, applied }. With ask=false, an open question takes its fallback.
// applied: every choice used and where it came from (answer | usual | default), for a "Change" link.
function decide(input, prefs = {}, answers = {}, ask = false) {
    const data = { ...input };
    const chosen = {}, questions = [], applied = [];
    for (const d of DECISIONS) {
        if (!d.when(data)) continue;
        const options = d.options(data);
        // An answer can be the option value or words from its label ("Darius" picks Sabaa "Darius" Ghomashchi)
        const norm = v => {
            if (v === undefined || v === null || v === '') return v;
            const n = d.normalize ? d.normalize(v) : v;
            if (options.some(o => o.value === n)) return n;
            const words = String(v).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            // labels as the documents wrote them too (a nickname may already be dropped from `data`)
            const asWritten = d.when(input) ? d.options(input) : [];
            const hit = words.length && [...options, ...asWritten].find(o => words.every(w => o.label.toLowerCase().includes(w)));
            return hit && options.some(o => o.value === hit.value) ? hit.value : n;
        };
        const valid = v => v !== undefined && v !== null && options.some(o => o.value === v);
        let v, source;
        if (valid(norm(answers[d.id]))) { v = norm(answers[d.id]); source = 'answer'; }
        else if (valid(norm(prefs[d.id]))) { v = norm(prefs[d.id]); source = 'usual'; }
        else if (ask) { questions.push({ id: d.id, question: d.question(data), options }); continue; }
        else { v = d.fallback(data); source = 'default'; }
        chosen[d.id] = v;
        applied.push({ id: d.id, question: d.question(data), options, value: v, source });
        d.apply(data, v);
    }
    return { data, chosen, questions, applied };
}

// Which attorney (0 or 1) signs, from the chosen key
function signerIndex(data, chosen) {
    const list = attorneysIn(data);
    if (!list.length) return -1;
    const hit = list.find(a => personKey(a.name) === chosen.signer);
    return hit ? hit.index : list[list.length - 1].index;
}

// Original form engine: signature lines follow the chosen signer; with caption = 'signer'
// the attorney block shows only that attorney
function applyAttorneys(data, chosen, before = data) {
    const list = attorneysIn(before);
    const a = list.find(x => personKey(x.name) === chosen.signer);
    if (!a) return data;
    data['[VAR_ATTY_NAME2]'] = `${a.name}, Esq.`;
    data['[VAR_ATTY2_NAME]'] = a.sbn ? `${a.name}, SBN: ${a.sbn}` : a.name;
    data['[VAR_CAPITAL_ATTY_NAME2]'] = a.name.toUpperCase();
    if (chosen.caption === 'signer') {
        data['[VAR_ATTY_WITH_SBN]'] = a.sbn ? `${a.name}, Esq., SBN ${a.sbn}` : `${a.name}, Esq.`;
        data['[ATTY_SBN]'] = a.sbn;
        if (a.email) data['[VAR_ATTY_EMAIL]'] = a.email;
        const others = list.filter(x => x !== a).map(x => x.name);
        if (data['[VAR_ATTY_BLOCK]']) data['[VAR_ATTY_BLOCK]'] = String(data['[VAR_ATTY_BLOCK]']).split('\n').filter(l => !others.some(o => l.startsWith(o))).join('\n');
    }
    return data;
}

// Answers worth remembering, merged into the saved prefs
function remember(prefs = {}, answers = {}) {
    const out = { ...prefs };
    for (const d of DECISIONS) if (answers[d.id] !== undefined && answers[d.id] !== '') out[d.id] = d.normalize ? d.normalize(answers[d.id]) : answers[d.id];
    return out;
}

const LABELS = { nicknames: 'Attorney nicknames in quotes', signer: 'Attorney who signs', caption: 'Attorneys in the caption' };
function describe(prefs = {}) {
    return Object.entries(prefs).filter(([k]) => LABELS[k]).map(([id, value]) => ({
        id, label: LABELS[id],
        value: id === 'nicknames' ? (value === 'drop' ? 'Left off' : 'Kept') : id === 'signer' ? value.replace(/^./, c => c.toUpperCase())
            : id === 'caption' ? (value === 'signer' ? 'Only the attorney who signs' : 'All attorneys') : String(value)
    }));
}

module.exports = { decide, applyAttorneys, signerIndex, remember, describe, attorneysIn, DECISIONS };
