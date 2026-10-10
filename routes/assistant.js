// ============================================================
// Kinecta Case Assistant — one AI for the whole case manager.
// Knows every case (documents read once, stored as text), answers questions,
// and acts through tools: look up cases, read documents, correct facts,
// add deadlines/events and fill Judicial Council forms.
// ============================================================
const express = require('express');
const { readMatter, writeMatter, listMatters, supabase, useSupabase } = require('../lib/matter-store');
const { listDocs, listAllDocs, buildTextContext, buildFileParts } = require('./documents');
const { GEMINI_BASE, GEMINI_MODEL, fetchWithRetry } = require('../lib/gemini');
const intel = require('../lib/case-intel');
const casework = require('./casework');

const router = express.Router();
const MAX_TOOL_STEPS = 6;
const CONTEXT_TEXT_BUDGET = 2400000; // characters of document text preloaded per question

// ---------- global chat history ----------
let memoryGlobalChat = [];
async function getGlobalHistory() {
    if (useSupabase) {
        const { data } = await supabase.from('global_chat').select('role, content, timestamp').order('id', { ascending: true }).limit(100);
        return (data || []).map(r => ({ role: r.role, content: r.content, timestamp: r.timestamp }));
    }
    return memoryGlobalChat;
}
async function appendGlobalHistory(entry) {
    if (useSupabase) {
        await supabase.from('global_chat').insert({ role: entry.role, content: entry.content, timestamp: entry.timestamp });
        return;
    }
    memoryGlobalChat.push(entry);
    if (memoryGlobalChat.length > 100) memoryGlobalChat = memoryGlobalChat.slice(-100);
}
async function clearGlobalHistory() {
    if (useSupabase) { await supabase.from('global_chat').delete().neq('id', 0); return; }
    memoryGlobalChat = [];
}

// ---------- prompt ----------
const IDENTITY = `You are **Kinecta Case Assistant**, an expert California collections legal assistant built into Wright Legal Group's case manager.
The firm represents Kinecta Federal Credit Union suing consumers on defaulted loans (auto, personal, credit card, HELOC) in California Superior Court — almost always limited civil cases (demand ≤ $35,000). You work for the paralegal and attorneys who prepare and e-file the Judicial Council forms, track service, defaults, judgments and enforcement, and keep each case file.

WHAT YOU KNOW (California collections practice — say "verify" when a rule matters and you are not certain):
- Pre-suit: demand / debt validation notice (DVN); wait out the validation period before filing.
- Filing: complaint (breach of contract / common counts), SUM-100 summons, CM-010 civil case cover sheet, LACIV 109 addendum for Los Angeles County.
- Service: personal (CCP 415.10); substituted (CCP 415.20 — complete 10 days after mailing); notice & acknowledgment (415.30). Serve and file proof of service within 60 days of filing (CRC 3.110(b)); 3-year outside limit (CCP 583.210).
- Response: 30 days after service is complete (CCP 412.20).
- Default: request entry of default (CIV-100) within 10 days after the response time expires (CRC 3.110(g)); mail a copy to the defendant (CCP 587); declaration of nonmilitary status.
- Default judgment: clerk judgment for a sum certain on contract (CCP 585(a)) or court judgment (585(b)) with declarations, interest, costs and attorney fees; dismiss the Doe defendants (CIV-110) or request separate judgment (CRC 3.1800(a)(7)); obtain judgment within 45 days after default entry (CRC 3.110(h)).
- Post-judgment: abstract of judgment (EJ-001) recorded to create a real-property lien; writ of execution (EJ-130); wage garnishment; debtor exam; renew within 10 years (CCP 683.020/683.130); post-judgment costs and interest (CCP 685.010 — consumer-debt rate changes apply to newer judgments; verify).

HOW YOU WORK:
- Facts come ONLY from the case documents and case record below (or tools). Cite the file name for facts. Never invent names, dates, amounts or case numbers — if something is not in the documents, say so and ask.
- Cases not shown in full below: use search_cases / get_case / read_case_documents before answering about them.
- To prepare a form ("fill out the request for default", "do the abstract", "prepare the summons"), call fill_form for the right case and form. Pass field_values only for information the user gave you or that you found in the documents and want to add. After it runs, say in one or two lines what was prepared and list what is missing so the user can tell you; a download button is shown automatically — never write URLs.
- When the user tells you something new about a case (served on…, default entered…, new address…), save it with update_case_facts and confirm what changed. Use add_deadline for reminders/follow-ups and add_case_event to log calls, payments or notes.
- "What needs attention / what's due / what should I work on" → call cases_needing_attention.
- Be concise and practical, like a sharp senior paralegal: lead with the answer, bold key facts, short bullets, dates written like March 17, 2026. Suggest the next concrete step when useful.`;

const TOOLS = [{
    functionDeclarations: [
        { name: 'search_cases', description: 'Find cases by debtor name, case number, court or stage. Returns matching cases with stage and next deadline.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Name, case number or keyword; empty for all cases' } } } },
        { name: 'get_case', description: 'Full case record: facts, dates, deadlines, hearings, document list with summaries, generated forms and form data on file.', parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING', description: 'Case id, case number or debtor name' } }, required: ['case_id'] } },
        { name: 'read_case_documents', description: 'Full text of a case\'s uploaded documents (all, or only the named files).', parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING' }, file_names: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional file names to read' } }, required: ['case_id'] } },
        { name: 'update_case_facts', description: `Save corrected or new case facts. Fields: ${casework.EDITABLE_FIELDS.join(', ')}; dates as "dates.<key>" with keys complaintFiled, served, serviceType, answerDue, answerReceived, defaultRequested, defaultEntered, judgmentEntered, abstractFiled, abstractRecorded, writIssued, judgmentRenewed, closed (YYYY-MM-DD); or form variables like "[DEBTOR1_SS_LAST4]". Empty value clears.`, parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING' }, updates: { type: 'ARRAY', items: { type: 'OBJECT', properties: { field: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['field', 'value'] } } }, required: ['case_id', 'updates'] } },
        { name: 'add_case_event', description: 'Log an event on the case timeline (call, payment, filing, note…).', parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING' }, type: { type: 'STRING', description: 'filing|hearing|service|correspondence|payment|client_contact|note' }, title: { type: 'STRING' }, date: { type: 'STRING', description: 'YYYY-MM-DD, default today' }, description: { type: 'STRING' } }, required: ['case_id', 'title'] } },
        { name: 'add_deadline', description: 'Add a reminder / deadline to a case.', parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING' }, title: { type: 'STRING' }, date: { type: 'STRING', description: 'YYYY-MM-DD' }, notes: { type: 'STRING' } }, required: ['case_id', 'title', 'date'] } },
        { name: 'list_forms', description: 'Judicial Council forms and firm templates the system can fill, with the variables each one uses.' },
        { name: 'fill_form', description: 'Fill a form for a case from the case documents/facts (plus firm profile) and save it to the case. Returns what was filled and what is missing.', parameters: { type: 'OBJECT', properties: { case_id: { type: 'STRING' }, form: { type: 'STRING', description: 'Form file or code, e.g. "CIV-100 (R4D).pdf", "EJ-001", "SUM-100"' }, field_values: { type: 'ARRAY', description: 'Extra/override values for form variables', items: { type: 'OBJECT', properties: { variable: { type: 'STRING', description: 'e.g. [COSTS] or COSTS' }, value: { type: 'STRING' } }, required: ['variable', 'value'] } } }, required: ['case_id', 'form'] } },
        { name: 'cases_needing_attention', description: 'Overdue and upcoming deadlines and hearings across all cases (next 14 days).' }
    ]
}];

// ---------- case context ----------
function factsBlock(m) {
    const d = m.dates || {};
    const rows = [
        ['Debtor', m.debtorName], ['Address', [m.debtorAddress, m.debtorCity, m.debtorState, m.debtorZip].filter(Boolean).join(', ')],
        ['Plaintiff / creditor', m.creditorName], ['Case number', m.caseNumber], ['Court', [m.courtName, m.courtBranch].filter(Boolean).join(' — ')],
        ['Court address', m.courtAddress], ['County', m.courtCounty], ['Demand', m.demandAmount], ['Judgment', m.judgmentAmount],
        ['Loan', m.loanType], ['Account', m.accountNumber], ['Service', [m.serviceType, m.servedBy && `by ${m.servedBy}`, m.serviceAddress && `at ${m.serviceAddress}`].filter(Boolean).join(' ')],
        ['Defendant response', m.defendantResponse], ['Status', m.statusText]
    ].filter(([, v]) => v);
    const dates = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('; ');
    return rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (dates ? `\nDates: ${dates}` : '');
}

function caseRecordText(m, docs) {
    const stage = intel.computeStage(m);
    const deadlines = intel.computeDeadlines(m).map(x => `- [${x.status}] ${x.date} ${x.title} (${x.rule})`).join('\n');
    const forms = (m.generatedForms || []).slice(0, 10).map(f => `- ${f.createdAt.slice(0, 10)} ${f.code} ${f.title}${f.missing && f.missing.length ? ` (missing: ${f.missing.join(', ')})` : ''}`).join('\n');
    const formData = Object.entries(m.formData || {}).map(([k, v]) => `${k}=${v}`).join('; ');
    const docList = docs.map(d => `- ${d.fileName}${d.analysis && d.analysis.documentType ? ` — ${d.analysis.documentType}` : ''}${d.analysis && d.analysis.documentDate ? ` (${d.analysis.documentDate})` : ''}`).join('\n');
    const events = (m.events || []).filter(e => e.addedBy !== 'system').slice(-15).map(e => `- ${String(e.date).slice(0, 10)} ${e.title}${e.description ? ': ' + e.description : ''}`).join('\n');
    return `=== CASE ${casework.caseLabel(m)} — id ${m.id} ===
Stage: ${stage.label}
${m.summary ? `Summary: ${m.summary}\n` : ''}${factsBlock(m)}
Deadlines (calculated):
${deadlines || '- none'}
${(m.customDeadlines || []).length ? '' : ''}Recent events:
${events || '- none'}
Generated forms:
${forms || '- none'}
Form variables on file: ${formData || 'none'}
Documents (${docs.length}):
${docList || '- none'}`;
}

// Cases whose documents to preload: the case in focus, or cases named in the question/recent turns
function pickFocusCases(matters, docsByMatter, message, recentText) {
    const words = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9-]{3,}/g) || []);
    const mentions = (m, w) => (String(m.debtorName || '').toLowerCase().match(/[a-z]{3,}/g) || []).some(t => w.has(t)) || (m.caseNumber && w.has(String(m.caseNumber).toLowerCase()));
    let picked = matters.filter(m => mentions(m, words(message)));
    if (!picked.length) picked = matters.filter(m => mentions(m, words(recentText)));
    const withDocs = matters.filter(m => (docsByMatter.get(m.id) || []).length);
    if (!picked.length && withDocs.length === 1) picked = withDocs;
    return picked.slice(0, 2);
}

function rosterText(matters) {
    const today = intel.todayLA();
    return matters.slice(0, 200).map(m => {
        const next = intel.nextDeadline(m, today);
        return `- ${casework.caseLabel(m)} | id ${m.id} | ${intel.computeStage(m, today).label}${next ? ` | next: ${next.title} ${next.date} (${next.status})` : ''}`;
    }).join('\n') || '- no cases yet';
}

function firmBlock(session) {
    const p = session && session.profile;
    if (!p) return '';
    const f = p.firm || {};
    const attys = (p.attorneys || []).filter(a => a.name).map(a => `${a.name}${a.sbn ? ' (SBN ' + a.sbn + ')' : ''}`).join('; ');
    return `Firm profile (used to fill attorney/firm blocks): ${[f.name, f.address, f.city, f.state, f.zip, f.phone].filter(Boolean).join(', ') || 'not set'}${attys ? `; attorneys: ${attys}` : ''}. Signed in as ${session.username}.`;
}

// ---------- tools ----------
async function runTool(name, args, ctx) {
    const findCase = async ref => {
        const m = casework.resolveCase(ctx.matters, ref);
        if (!m) throw new Error(`No case matches "${ref}"`);
        return readMatter(m.id);
    };
    switch (name) {
        case 'search_cases': {
            const q = String(args.query || '').toLowerCase().trim();
            const today = intel.todayLA();
            const list = ctx.matters.filter(m => !q || `${m.debtorName} ${m.caseNumber} ${m.courtName} ${m.courtCounty} ${intel.computeStage(m, today).label}`.toLowerCase().includes(q));
            return { count: list.length, cases: list.slice(0, 50).map(m => ({ id: m.id, debtor: m.debtorName, caseNumber: m.caseNumber, court: m.courtName, stage: intel.computeStage(m, today).label, next: intel.nextDeadline(m, today) })) };
        }
        case 'get_case': {
            const m = await findCase(args.case_id);
            const docs = await listDocs(m.id);
            return { record: caseRecordText(m, docs), documents: docs.map(d => ({ file: d.fileName, type: d.analysis && d.analysis.documentType, date: d.analysis && d.analysis.documentDate, summary: d.analysis && d.analysis.summary, keyFacts: d.analysis && d.analysis.keyFacts })) };
        }
        case 'read_case_documents': {
            const m = await findCase(args.case_id);
            let docs = await listDocs(m.id);
            const names = (args.file_names || []).map(n => String(n).toLowerCase());
            if (names.length) docs = docs.filter(d => names.some(n => d.fileName.toLowerCase().includes(n) || n.includes(d.fileName.toLowerCase())));
            const t = await buildTextContext(docs, { maxChars: 1500000 });
            return { case: casework.caseLabel(m), text: t.text || '(no stored text yet — documents not read)', notReadYet: t.unread.map(d => d.fileName), unreadable: t.unsupported };
        }
        case 'update_case_facts': {
            const m = await findCase(args.case_id);
            const updates = {};
            for (const u of args.updates || []) if (u && u.field) updates[u.field] = u.value;
            const result = casework.updateFacts(m, updates, 'assistant');
            if (result.changed.length) { await writeMatter(m.id, m); ctx.changedCases.add(m.id); }
            return { case: casework.caseLabel(m), ...result, stageNow: intel.computeStage(m).label };
        }
        case 'add_case_event': {
            const m = await findCase(args.case_id);
            const ev = casework.addEvent(m, args, 'assistant');
            await writeMatter(m.id, m);
            ctx.changedCases.add(m.id);
            return { case: casework.caseLabel(m), event: ev };
        }
        case 'add_deadline': {
            const m = await findCase(args.case_id);
            const item = casework.addDeadline(m, args, 'assistant');
            await writeMatter(m.id, m);
            ctx.changedCases.add(m.id);
            return { case: casework.caseLabel(m), deadline: item };
        }
        case 'list_forms': {
            const forms = [];
            for (const f of intel.FORM_CATALOG) forms.push({ ...f, variables: await casework.formVariables(f) });
            return { forms };
        }
        case 'fill_form': {
            const m = await findCase(args.case_id);
            const values = {};
            for (const v of args.field_values || []) if (v && v.variable) values[v.variable] = v.value;
            const rec = await casework.generateForm(m, args.form, values, ctx.session, 'assistant');
            await writeMatter(m.id, m);
            ctx.changedCases.add(m.id);
            ctx.actions.push({ type: 'form', caseId: m.id, formId: rec.id, label: `${rec.code} — ${rec.title}` });
            return { case: casework.caseLabel(m), prepared: `${rec.code} ${rec.title}`, fileName: rec.fileName, fieldsFilled: rec.filledCount, missing: rec.missing, note: 'A download button is shown to the user automatically.' };
        }
        case 'cases_needing_attention': {
            return { today: intel.isoDate(intel.todayLA()), items: casework.attentionItems(ctx.matters).slice(0, 40) };
        }
        default:
            throw new Error(`Unknown tool ${name}`);
    }
}

// ---------- Gemini ----------
async function callGemini(systemPrompt, contents) {
    const url = `${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            tools: TOOLS,
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 1024 } }
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`AI service error (HTTP ${response.status}): ${errText.slice(0, 200)}`);
        err.fileGone = /file|permission/i.test(errText) && [400, 403, 404].includes(response.status);
        err.tooLarge = /token|too large|exceed/i.test(errText);
        throw err;
    }
    const result = await response.json();
    return result.candidates && result.candidates[0];
}

// One assistant turn: preload context, then let the model call tools until it answers
async function runAssistant({ session, message, caseId, history }) {
    const [matters, docsByMatter] = await Promise.all([listMatters(), listAllDocs().catch(() => new Map())]);
    const cases = matters.filter(m => !m.isInbox);
    const ctx = { session, matters: cases, actions: [], changedCases: new Set() };

    let focus = [];
    if (caseId) {
        const m = cases.find(x => x.id === caseId);
        if (m) focus = [m];
    } else {
        const recent = history.filter(h => h.role === 'user').slice(-4).map(h => h.content).join(' ');
        focus = pickFocusCases(cases, docsByMatter, message, recent);
    }

    // Stored document text for the focus cases; unread files are attached
    let docText = '';
    let budget = CONTEXT_TEXT_BUDGET;
    const fileParts = [];
    const notes = [];
    for (const m of focus) {
        const docs = docsByMatter.get(m.id) || [];
        const t = await buildTextContext(docs, { labelPrefix: `Case ${casework.caseLabel(m)} — `, maxChars: Math.max(budget, 0) });
        budget -= t.text.length;
        docText += `\n\n${caseRecordText(m, docs)}\nFULL TEXT OF DOCUMENTS:\n${t.text || '(none read yet)'}`;
        if (t.unread.length) {
            try {
                const f = await buildFileParts(t.unread, { labelPrefix: `Case ${casework.caseLabel(m)} — ` });
                fileParts.push(...f.parts);
                if (f.skipped.length) notes.push(`could not read: ${f.skipped.join('; ')}`);
            } catch (e) { notes.push(`could not read unprocessed documents: ${e.message}`); }
        }
    }

    const today = intel.todayLA();
    const systemPrompt = `${IDENTITY}

Today is ${intel.longDate(today)} (${intel.isoDate(today)}).
${firmBlock(session)}

FORMS AVAILABLE (fill_form): ${intel.FORM_CATALOG.map(f => `${f.file} = ${f.code} ${f.title} [${f.stage}]`).join('; ')}

ALL CASES:
${rosterText(cases)}
${caseId && focus.length ? `\nThe user is looking at the case page for ${casework.caseLabel(focus[0])}; "this case" means it.` : ''}
${focus.length ? `\nCASES IN FOCUS (full record and document text):${docText}` : '\nNo case is in focus; use the tools to look cases up.'}
${notes.length ? `\nNote: ${notes.join(' ')}` : ''}`;

    const contents = history.slice(-20).map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] }));
    contents.push({ role: 'user', parts: [...(fileParts.length ? [{ text: 'UNPROCESSED CASE FILES:' }, ...fileParts] : []), { text: message }] });

    let finalText = '';
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const candidate = await callGemini(systemPrompt, contents);
        const parts = (candidate && candidate.content && candidate.content.parts) || [];
        const calls = parts.filter(p => p.functionCall);
        if (!calls.length) {
            finalText = parts.map(p => p.text || '').join('').trim();
            if (!finalText && candidate && candidate.finishReason) finalText = `I couldn't complete that (${candidate.finishReason}). Please rephrase or try again.`;
            break;
        }
        contents.push({ role: 'model', parts });
        const responses = [];
        for (const p of calls) {
            const { name, args } = p.functionCall;
            let result;
            try {
                result = await runTool(name, args || {}, ctx);
            } catch (e) {
                result = { error: e.message };
            }
            ctx.log = (ctx.log || []).concat({ tool: name, args, ok: !result.error });
            responses.push({ functionResponse: { name, response: { result } } });
        }
        contents.push({ role: 'user', parts: responses });
        if (step === MAX_TOOL_STEPS - 1) finalText = 'I ran out of steps while working on that. Here is what I did so far — please check the case page.';
    }

    // Buttons for prepared forms
    if (ctx.actions.length) {
        finalText += '\n\n' + ctx.actions.map(a => `[[form:${a.caseId}:${a.formId}|${a.label}]]`).join('\n');
    }
    return { text: finalText || 'I was unable to generate a response. Please try again.', changedCases: [...ctx.changedCases], toolLog: ctx.log || [] };
}

// ============================================================
// ROUTES
// ============================================================
router.post('/api/assistant', async (req, res) => {
    const message = String(req.body.message || '').trim();
    const caseId = req.body.caseId || null;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    try {
        const userEntry = { role: 'user', content: message, timestamp: new Date().toISOString() };
        let history;
        if (caseId) {
            const m = await readMatter(caseId);
            history = m.chatHistory || [];
        } else {
            history = await getGlobalHistory();
        }

        let reply;
        if (!process.env.GOOGLE_API_KEY) {
            reply = { text: 'AI is not configured (no GOOGLE_API_KEY).', changedCases: [], toolLog: [] };
        } else {
            try {
                reply = await runAssistant({ session: req.session, message, caseId, history });
            } catch (e) {
                console.error('[Assistant] Failed:', e.message);
                reply = { text: `I couldn't complete that right now (${e.message}). Please try again in a moment.`, changedCases: [], toolLog: [] };
            }
        }
        const assistantEntry = { role: 'assistant', content: reply.text, timestamp: new Date().toISOString() };

        // Save the exchange (case chat lives on the case; re-read it because tools may have changed it)
        if (caseId) {
            const m = await readMatter(caseId);
            m.chatHistory = [...(m.chatHistory || []), userEntry, assistantEntry].slice(-100);
            await writeMatter(m.id, m);
        } else {
            await appendGlobalHistory(userEntry);
            await appendGlobalHistory(assistantEntry);
        }
        res.json({ message: assistantEntry, changedCases: reply.changedCases, toolLog: reply.toolLog });
    } catch (err) {
        console.error('[Assistant] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/assistant/history', async (req, res) => {
    try {
        if (req.query.caseId) {
            const m = await readMatter(req.query.caseId);
            return res.json(m.chatHistory || []);
        }
        res.json(await getGlobalHistory());
    } catch (err) {
        res.json([]);
    }
});

router.delete('/api/assistant/history', async (req, res) => {
    try {
        if (req.query.caseId) {
            const m = await readMatter(req.query.caseId);
            m.chatHistory = [];
            await writeMatter(m.id, m);
        } else {
            await clearGlobalHistory();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports.runAssistant = runAssistant;
