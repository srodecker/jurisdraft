// ============================================================
// Assistant chat — used full-page (all cases) and as the case copilot panel
// ============================================================
import { api, esc, formatAi, icon, toast, emit, action } from './core.js';

const chats = {};   // id → { caseId, history, sending, loaded, suggestions }

export function chatMarkup(id, { page = false, placeholder } = {}) {
    return `<div class="chat ${page ? 'page-chat' : ''}" data-chat="${id}">
        <div class="msgs" id="${id}-msgs"></div>
        <div class="composer">
            <textarea id="${id}-in" rows="1" placeholder="${esc(placeholder || 'Ask, or tell me what to do…')}"></textarea>
            <button class="btn primary icon" id="${id}-send" data-act="chat-send" data-id="${id}" title="Send (Enter)">${icon('arrow')}</button>
        </div>
    </div>`;
}

function render(id) {
    const c = chats[id];
    const box = document.getElementById(id + '-msgs');
    if (!c || !box) return;
    if (!c.history.length && !c.sending) {
        box.innerHTML = `<div class="empty" style="padding:28px 8px">
            <div class="logo" style="width:40px;height:40px;margin:0 auto 10px;border-radius:12px">${icon('sparkle')}</div>
            <div class="big">${c.caseId ? 'Ask about this case' : 'Your case assistant'}</div>
            <div>${c.caseId ? 'I answer from this case\'s documents and can update facts, add reminders and prepare forms.' : 'I know every case and its documents. Ask anything, or tell me to update a case, add a reminder or prepare a form.'}</div>
            <div class="suggest">${c.suggestions.map(s => `<button data-act="chat-suggest" data-id="${id}" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        </div>`;
        return;
    }
    box.innerHTML = c.history.map(h => `<div class="msg ${h.role === 'user' ? 'user' : 'ai'}"><div class="av">${h.role === 'user' ? 'You' : 'AI'}</div><div class="bubble">${h.role === 'user' ? esc(h.content) : formatAi(h.content)}</div></div>`).join('')
        + (c.sending ? `<div class="msg ai"><div class="av">AI</div><div class="typing"><i></i><i></i><i></i>reading the case file…</div></div>` : '');
    box.scrollTop = box.scrollHeight;
}

export async function mountChat(id, caseId, suggestions, { initial } = {}) {
    const prev = chats[id];
    if (prev && prev.caseId === caseId && (prev.sending || prev.loaded)) {
        prev.suggestions = suggestions;
        render(id);
        bindInput(id);
        if (initial) send(id, initial);
        return;
    }
    const c = chats[id] = { caseId, history: [], sending: false, loaded: false, suggestions };
    render(id);
    bindInput(id);
    try { c.history = await api(`/api/assistant/history${caseId ? '?caseId=' + caseId : ''}`); } catch (_) {}
    c.loaded = true;
    if (chats[id] !== c) return;
    render(id);
    if (initial) send(id, initial);
}

function bindInput(id) {
    const ta = document.getElementById(id + '-in');
    if (!ta || ta.dataset.bound) return;
    ta.dataset.bound = '1';
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(id); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
}

export async function send(id, text) {
    const c = chats[id];
    const ta = document.getElementById(id + '-in');
    const msg = (text || (ta && ta.value) || '').trim();
    if (!c || !msg || c.sending) return;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    c.history.push({ role: 'user', content: msg });
    c.sending = true;
    render(id);
    try {
        const r = await api('/api/assistant', { json: { message: msg, caseId: c.caseId } });
        c.history.push(r.message);
        if (r.changedCases && r.changedCases.length) emit('cases-changed', r.changedCases);
    } catch (e) {
        c.history.push({ role: 'assistant', content: `Sorry — ${e.message}` });
    } finally {
        c.sending = false;
        render(id);
    }
}

export async function clearChat(id) {
    const c = chats[id];
    if (!c || !confirm('Clear this conversation?')) return;
    try {
        await api(`/api/assistant/history${c.caseId ? '?caseId=' + c.caseId : ''}`, { method: 'DELETE' });
        c.history = [];
        render(id);
    } catch (e) { toast(e.message, 'err'); }
}

action('chat-send', d => send(d.id));
action('chat-suggest', d => send(d.id, d.text));
action('chat-clear', d => clearChat(d.id));
