// ============================================================
// Calendar (all deadlines + hearings), ICS feed, client status report, system status
// ============================================================
const express = require('express');
const crypto = require('crypto');
const XLSX = require('xlsx');
const intel = require('../lib/case-intel');
const { listMatters } = require('../lib/matter-store');
const { listAllDocs, docStatus } = require('./documents');
const settingsStore = require('../lib/settings-store');
const { caseLabel } = require('./casework');

const router = express.Router();

// ---------- calendar ----------
async function calendarItems({ from, to, includeDone = true } = {}) {
    const matters = (await listMatters()).filter(m => !m.isInbox && m.status !== 'closed');
    const today = intel.todayLA();
    const items = [];
    for (const m of matters) {
        for (const d of intel.computeDeadlines(m, today)) {
            if (!d.date) continue;
            if (from && d.date < from) continue;
            if (to && d.date > to) continue;
            if (!includeDone && d.status === 'done') continue;
            items.push({ ...d, caseId: m.id, caseLabel: caseLabel(m) });
        }
    }
    return items.sort((a, b) => a.date.localeCompare(b.date));
}

router.get('/api/calendar', async (req, res) => {
    try {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
        res.json({ today: intel.isoDate(intel.todayLA()), items: await calendarItems({ from, to }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Subscription link for Outlook / Google Calendar (token-protected, no login header possible)
router.get('/api/calendar/feed', async (req, res) => {
    try {
        const user = req.session.username;
        const s = await settingsStore.getSettings(user);
        if (!s.icsToken || req.query.reset === '1') {
            s.icsToken = crypto.randomBytes(18).toString('base64url');
            await settingsStore.saveSettings(user, s);
        }
        const base = `${(req.get('x-forwarded-proto') || req.protocol).split(',')[0]}://${req.get('host')}`;
        res.json({ url: `${base}/ics/${encodeURIComponent(user)}/${s.icsToken}/deadlines.ics` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); }

router.get('/ics/:user/:token/deadlines.ics', async (req, res) => {
    try {
        const s = await settingsStore.getSettings(req.params.user);
        const a = Buffer.from(String(s.icsToken || ''));
        const b = Buffer.from(String(req.params.token || ''));
        if (!s.icsToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found');
        // Every open item, overdue ones included — an old missed deadline still needs doing
        const items = await calendarItems({ includeDone: false });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JurisDraft//Kinecta Case Manager//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Kinecta case deadlines', 'X-WR-TIMEZONE:America/Los_Angeles'];
        for (const it of items) {
            const day = it.date.replace(/-/g, '');
            const next = intel.isoDate(new Date(Date.parse(it.date + 'T00:00:00Z') + 86400000)).replace(/-/g, '');
            const title = `${it.kind === 'hearing' ? '⚖ ' : ''}${it.title} — ${it.caseLabel}`;
            lines.push('BEGIN:VEVENT', `UID:${it.caseId}-${it.key}@jurisdraft`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
                icsFold(`SUMMARY:${icsEscape(title)}`), icsFold(`DESCRIPTION:${icsEscape(`${it.rule || ''}${it.form ? `\nForm: ${it.form}` : ''}`)}`), 'END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        res.set('Content-Type', 'text/calendar; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        res.send(lines.join('\r\n'));
    } catch (err) { res.status(500).send(err.message); }
});

// ---------- client status report ----------
function lastAction(m, since) {
    // Case events that matter to the client (not app bookkeeping like "Case opened" or fact edits)
    const events = [...(m.events || [])].filter(e => e.title && e.type !== 'note' && e.type !== 'status_change' && !/^Case opened$|^Facts updated/i.test(e.title))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latest = events[0] || null;
    const changes = since ? events.filter(e => String(e.date).slice(0, 10) >= since) : [];
    return { latest, changes };
}

async function portfolio({ since = null, includeClosed = false } = {}) {
    const [matters, docsByMatter] = await Promise.all([listMatters(), listAllDocs().catch(() => new Map())]);
    const today = intel.todayLA();
    return matters.filter(m => !m.isInbox && (includeClosed || m.status !== 'closed')).map(m => {
        const stage = intel.computeStage(m, today);
        const next = intel.nextDeadline(m, today);
        const { latest, changes } = lastAction(m, since);
        const docs = docsByMatter.get(m.id) || [];
        const d = m.dates || {};
        return {
            id: m.id,
            debtor: m.debtorName || '',
            caseNumber: m.caseNumber || '',
            account: m.accountNumber || '',
            court: [m.courtCounty ? `${m.courtCounty} County` : '', m.courtBranch].filter(Boolean).join(' — ') || m.courtName || '',
            stage: stage.label,
            filed: d.complaintFiled || '',
            served: d.served || '',
            defaultEntered: d.defaultEntered || '',
            judgmentEntered: d.judgmentEntered || '',
            demand: m.demandAmount || '',
            judgment: m.judgmentAmount || '',
            balance: m.payoffBalance || '',
            lastAction: latest ? latest.title : '',
            lastActionDate: latest ? String(latest.date).slice(0, 10) : '',
            status: m.reportNote || m.statusText || '',
            nextStep: m.nextStep || (next ? next.title : ''),
            nextDate: next ? next.date : '',
            nextStatus: next ? next.status : '',
            changesSince: changes.map(e => `${String(e.date).slice(0, 10)} ${e.title}`),
            documents: docs.length,
            unread: docs.filter(x => ['queued', 'reading'].includes(docStatus(x))).length,
            closed: m.status === 'closed'
        };
    }).sort((a, b) => a.debtor.localeCompare(b.debtor));
}

router.get('/api/reports/portfolio', async (req, res) => {
    try {
        const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
        res.json({ generated: intel.isoDate(intel.todayLA()), since, rows: await portfolio({ since, includeClosed: req.query.closed === '1' }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/reports/portfolio.xlsx', async (req, res) => {
    try {
        const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
        const rows = await portfolio({ since, includeClosed: req.query.closed === '1' });
        const money = v => { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? '' : n; };
        const sheet = rows.map(r => ({
            'Debtor': r.debtor, 'Case #': r.caseNumber, 'Account #': r.account, 'Court': r.court, 'Stage': r.stage,
            'Complaint filed': r.filed, 'Served': r.served, 'Default entered': r.defaultEntered, 'Judgment entered': r.judgmentEntered,
            'Demand': money(r.demand), 'Judgment amount': money(r.judgment), 'Balance': money(r.balance),
            'Last action': r.lastAction, 'Last action date': r.lastActionDate, 'Status': r.status, 'Next step': r.nextStep, 'Next date': r.nextDate,
            ...(since ? { [`Activity since ${since}`]: r.changesSince.join('; ') } : {})
        }));
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(sheet);
        ws['!cols'] = Object.keys(sheet[0] || { a: 1 }).map(k => ({ wch: ['Status', 'Next step', 'Last action'].includes(k) || k.startsWith('Activity') ? 50 : 16 }));
        XLSX.utils.book_append_sheet(wb, ws, 'Status report');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', `attachment; filename="Kinecta status report ${intel.isoDate(intel.todayLA())}.xlsx"`);
        res.send(buf);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- system status (Settings page) ----------
router.get('/api/system/status', async (req, res) => {
    try {
        const useSupabase = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY));
        let schema = { ok: true };
        const docs = { total: 0, done: 0, pending: 0, error: 0 };
        try {
            const all = [...(await listAllDocs()).values()].flat();
            docs.total = all.length;
            for (const d of all) {
                const s = docStatus(d);
                if (s === 'done') docs.done++;
                else if (s === 'queued' || s === 'reading') docs.pending++;
                else if (s === 'error') docs.error++;
            }
        } catch (e) { schema = { ok: false, error: e.message }; }
        if (useSupabase && schema.ok) {
            const { createClient } = require('@supabase/supabase-js');
            const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
            const { error } = await sb.from('case_documents').select('id, analysis, full_text, text_chars').limit(1);
            if (error) schema = { ok: false, error: error.message };
        }
        res.json({ storage: useSupabase ? 'supabase' : 'file', ai: !!process.env.GOOGLE_API_KEY, cron: !!process.env.CRON_SECRET, schema, docs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
