// ============================================================
// Background reading: keeps calling POST /api/jobs/tick while documents wait.
// The server holds the queue, so closing the page only pauses it.
// ============================================================
import { api, state, emit, esc, toast } from './core.js';

export const queue = { running: false, remaining: 0, progress: {}, focus: null };

export function caseProgress(caseId) {
    return queue.progress[caseId] || null;
}

function summaryText() {
    const all = Object.values(queue.progress);
    const total = all.reduce((n, p) => n + p.total, 0);
    const done = all.reduce((n, p) => n + p.done, 0);
    const pending = all.reduce((n, p) => n + p.pending, 0);
    const upgrading = all.reduce((n, p) => n + p.upgrading, 0);
    if (pending) return `Reading documents · ${done} of ${total}`;
    if (upgrading) return `Re-checking documents for detail · ${done - upgrading} of ${done}`;
    return '';
}

export function renderActivity() {
    const el = document.getElementById('activity');
    if (!el) return;
    const text = (queue.running || queue.remaining) ? summaryText() : '';
    el.innerHTML = text ? `<div class="spin"></div><span>${esc(text)}</span>` : '';
}

export async function refreshStatus() {
    try {
        const s = await api('/api/jobs/status');
        queue.remaining = s.remaining;
        queue.progress = s.progress || {};
        renderActivity();
        if (s.remaining) drive();
    } catch (_) {}
}

// Run until nothing is left. Emits 'queue' after every tick so open views can refresh.
export async function drive(caseId = null) {
    if (caseId) queue.focus = caseId;
    if (queue.running) return;
    queue.running = true;
    renderActivity();
    try {
        for (let i = 0; i < 600; i++) {
            let r;
            try {
                r = await api('/api/jobs/tick', { json: { caseId: state.caseId || queue.focus } });
            } catch (e) {
                if (e.data && e.data.code === 'SCHEMA') { state.schemaProblem = { detail: e.data.error, sql: e.data.sql }; emit('schema'); return; }
                toast(`Background reading paused: ${e.message}`, 'err');
                return;
            }
            queue.remaining = r.remaining;
            queue.progress = { ...queue.progress, ...r.progress };
            renderActivity();
            const failed = (r.processed || []).filter(p => p.result === 'error');
            if (failed.length) toast(`${failed.length} document${failed.length === 1 ? '' : 's'} couldn't be read — open the case's Documents tab to retry`, 'warn');
            emit('queue', r);
            if (!r.remaining) break;
            if (!(r.processed || []).length) await new Promise(res => setTimeout(res, Math.min(Math.max(r.retryInMs || 3000, 2000), 15000)));
        }
    } finally {
        queue.running = false;
        renderActivity();
        emit('queue-idle');
    }
}
