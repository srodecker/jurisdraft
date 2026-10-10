// ============================================================
// Turn an uploaded case document into plain text, once.
// - Digital PDFs: text layer (unpdf). Scanned PDFs, PDFs with filled form
//   fields and images: AI transcription (Gemini), split into page chunks.
// - .docx: document.xml text.  .eml / .msg: headers + body + attachments.
// The result is stored with the document so chat never has to re-read files.
// ============================================================
const { extractText: pdfTextLayer, getDocumentProxy } = require('unpdf');
const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } = require('pdf-lib');
const { simpleParser } = require('mailparser');
const MsgReader = require('@kenjiuno/msgreader').default;
const { decompressRTF } = require('@kenjiuno/decompressrtf');
const { GEMINI_NATIVE, resolveMime, docxToText, generateText, uploadToFileApi } = require('./gemini');

const INLINE_MAX_BYTES = 14 * 1024 * 1024; // Gemini inline request limit is ~20 MB after base64
const PAGES_PER_CHUNK = 20;                 // keeps each transcription under the output token limit
const MIN_CHARS_PER_PAGE = 150;             // below this a PDF is treated as scanned
const MAX_TEXT_CHARS = 2000000;             // per document
const MAX_ATTACHMENTS = 10;
const MAX_EMAIL_DEPTH = 2;                  // email → attachment → nested attachment

const TRANSCRIBE_PROMPT = `Transcribe ALL text in the attached document exactly as written, in reading order.
- Start each page with "--- Page N ---".
- Include headers, footers, stamps, handwriting, dates, case numbers, amounts and table contents.
- Include the values typed or written into form fields, next to their labels.
- Show checkboxes as [X] when checked and [ ] when empty.
- Write [signature] where a signature appears.
Output plain text only — no commentary, no summary.`;

class UnsupportedFileError extends Error {}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

// ---- AI transcription ----
async function transcribe(buffer, mime, label) {
    const part = buffer.length <= INLINE_MAX_BYTES
        ? { inline_data: { mime_type: mime, data: buffer.toString('base64') } }
        : (await uploadToFileApi(buffer, mime, label)).part;
    const { text, finishReason } = await generateText([{ text: TRANSCRIBE_PROMPT }, part]);
    return { text: text.trim(), truncated: finishReason === 'MAX_TOKENS' };
}

// ---- PDF ----
async function pdfFormFields(buffer) {
    try {
        const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const out = [];
        for (const f of doc.getForm().getFields()) {
            let value = null;
            if (f instanceof PDFTextField) value = f.getText();
            else if (f instanceof PDFCheckBox) value = f.isChecked() ? '[X]' : null;
            else if (f instanceof PDFDropdown) value = f.getSelected().join(', ');
            else if (f instanceof PDFRadioGroup) value = f.getSelected();
            if (value && String(value).trim()) {
                const name = f.getName().split('.').pop().replace(/\[\d+\]/g, '').trim() || f.getName();
                out.push(`${name}: ${String(value).trim()}`);
            }
        }
        return out;
    } catch (_) {
        return [];
    }
}

// Split a PDF into page ranges for transcription; returns [{ buffer, from, to }]
async function splitPdf(buffer, pageCount) {
    if (!pageCount || pageCount <= PAGES_PER_CHUNK) return [{ buffer, from: 1, to: pageCount || null }];
    try {
        const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const chunks = [];
        for (let start = 0; start < pageCount; start += PAGES_PER_CHUNK) {
            const end = Math.min(start + PAGES_PER_CHUNK, pageCount);
            const out = await PDFDocument.create();
            const pages = await out.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
            pages.forEach(p => out.addPage(p));
            chunks.push({ buffer: Buffer.from(await out.save()), from: start + 1, to: end });
        }
        return chunks;
    } catch (_) {
        return [{ buffer, from: 1, to: pageCount }];
    }
}

async function pdfToText(buffer, label) {
    let pages = [];
    let pageCount = 0;
    try {
        const pdf = await getDocumentProxy(new Uint8Array(buffer));
        const result = await pdfTextLayer(pdf, { mergePages: false });
        pages = result.text || [];
        pageCount = result.totalPages || pages.length;
    } catch (_) { /* unreadable text layer — rely on AI */ }

    const fields = await pdfFormFields(buffer);
    const layerText = pages.map((t, i) => `--- Page ${i + 1} ---\n${String(t).trim()}`).join('\n\n');
    const visibleChars = pages.join('').replace(/\s/g, '').length;
    const scanned = !pageCount || visibleChars / pageCount < MIN_CHARS_PER_PAGE;
    const fieldsBlock = fields.length ? `\n\n--- Filled form field values ---\n${fields.join('\n')}` : '';

    if (!scanned && !fields.length) return { text: layerText, method: 'pdf-text' };

    try {
        const chunks = await splitPdf(buffer, pageCount);
        const results = await mapLimit(chunks, 4, c => transcribe(c.buffer, 'application/pdf', label));
        let text = results.map((r, i) => chunks.length > 1 ? `[Pages ${chunks[i].from}-${chunks[i].to}]\n${r.text}` : r.text).join('\n\n');
        if (results.some(r => r.truncated) && visibleChars > 0) {
            text += `\n\n--- Text layer (AI transcription was cut short) ---\n${layerText}`;
        }
        return { text: text + fieldsBlock, method: 'ai-transcription' };
    } catch (e) {
        // AI unavailable: keep whatever the text layer has
        if (visibleChars > 50) return { text: layerText + fieldsBlock, method: 'pdf-text', warning: e.message };
        throw e;
    }
}

// ---- HTML / RTF ----
function decodeEntities(s) {
    return s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/gi, '&');
}

function htmlToText(html) {
    return decodeEntities(String(html || '')
        .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
        .replace(/<\/t[dh]>/gi, '\t')
        .replace(/<[^>]+>/g, ''))
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Plain text from RTF (Outlook stores some message bodies only as compressed RTF,
// sometimes wrapping HTML). Skips formatting groups and RTF-only/HTML-tag runs.
function rtfToText(rtf) {
    let out = '';
    let depth = 0;
    const skipStack = [];
    let skip = false;
    let htmlrtf = false;
    for (let i = 0; i < rtf.length; i++) {
        const c = rtf[i];
        if (c === '{') {
            skipStack.push(skip);
            depth++;
            if (rtf.startsWith('{\\*', i) || /^\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)/.test(rtf.slice(i, i + 12))) skip = true;
            continue;
        }
        if (c === '}') { skip = skipStack.pop() || false; depth--; continue; }
        if (c === '\\') {
            const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i, i + 40));
            if (!m) continue;
            i += m[0].length - 1;
            if (skip) continue;
            if (m[3]) { if (!htmlrtf) out += String.fromCharCode(parseInt(m[3], 16)); continue; }
            if (m[4]) { if (!htmlrtf && '\\{}'.includes(m[4])) out += m[4]; continue; }
            const word = m[1];
            if (word === 'htmlrtf') { htmlrtf = m[2] !== '0'; continue; }
            if (htmlrtf) continue;
            if (word === 'par' || word === 'line') out += '\n';
            else if (word === 'tab') out += '\t';
            else if (word === 'u' && m[2]) { out += String.fromCharCode((Number(m[2]) + 65536) % 65536); i += rtf[i + 1] === '?' ? 1 : 0; }
            continue;
        }
        if (skip || htmlrtf || c === '\r' || c === '\n') continue;
        out += c;
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Email ----
async function composeEmail({ from, to, cc, date, subject, body, attachments }, depth) {
    const header = [
        `From: ${from || '-'}`,
        `To: ${to || '-'}`,
        cc ? `Cc: ${cc}` : null,
        `Date: ${date || '-'}`,
        `Subject: ${subject || '-'}`
    ].filter(Boolean).join('\n');
    let text = `${header}\n\n${(body || '').trim() || '(no message body)'}`;
    const list = attachments.slice(0, MAX_ATTACHMENTS);
    if (list.length) text += `\n\nAttachments: ${list.map(a => a.fileName).join(', ')}`;
    for (const att of list) {
        if (depth >= MAX_EMAIL_DEPTH) { text += `\n\n=== Attachment: ${att.fileName} (not read: nested too deep) ===`; continue; }
        try {
            const r = await extractDocumentText(att.buffer, att.mime, att.fileName, depth + 1);
            text += `\n\n=== Attachment: ${att.fileName} ===\n${r.text}`;
        } catch (e) {
            text += `\n\n=== Attachment: ${att.fileName} (could not be read: ${e instanceof UnsupportedFileError ? 'file type not supported' : e.message}) ===`;
        }
    }
    if (attachments.length > MAX_ATTACHMENTS) text += `\n\n(${attachments.length - MAX_ATTACHMENTS} more attachment(s) not read)`;
    return text;
}

// Small inline images are usually logos/signatures — not worth transcribing
const isNoiseImage = a => /^image\//.test(a.mime || '') && a.buffer.length < 30 * 1024;

async function emlToText(buffer, depth) {
    const m = await simpleParser(buffer);
    const attachments = (m.attachments || [])
        .map(a => ({ fileName: a.filename || 'attachment', mime: a.contentType, buffer: a.content }))
        .filter(a => !isNoiseImage(a));
    return composeEmail({
        from: m.from && m.from.text,
        to: m.to && m.to.text,
        cc: m.cc && m.cc.text,
        date: m.date ? m.date.toISOString() : null,
        subject: m.subject,
        body: m.text || htmlToText(m.html || ''),
        attachments
    }, depth);
}

async function msgToText(buffer, depth) {
    const reader = new MsgReader(buffer);
    const d = reader.getFileData();
    if (d.error) throw new Error(`Could not read Outlook message: ${d.error}`);
    const person = r => [r.name, r.smtpAddress || r.email].filter((v, i, a) => v && a.indexOf(v) === i).join(' ').trim();
    const recips = (d.recipients || []);
    const byType = t => recips.filter(r => (r.recipType || 'to') === t).map(person).filter(Boolean).join(', ');
    let body = (d.body || '').trim();
    if (!body && d.bodyHtml) body = htmlToText(d.bodyHtml);
    if (!body && d.compressedRtf) {
        try { body = rtfToText(Buffer.from(decompressRTF(Array.from(d.compressedRtf))).toString('latin1')); } catch (_) {}
    }
    const attachments = [];
    for (const a of d.attachments || []) {
        try {
            const att = reader.getAttachment(a);
            const fileName = att.fileName || a.fileName || a.name || 'attachment';
            const mime = a.innerMsgContent ? 'application/vnd.ms-outlook' : (a.attachMimeTag || null);
            attachments.push({ fileName: a.innerMsgContent && !/\.msg$/i.test(fileName) ? `${fileName}.msg` : fileName, mime, buffer: Buffer.from(att.content) });
        } catch (_) { /* skip unreadable attachment */ }
    }
    return composeEmail({
        from: [d.senderName, d.senderSmtpAddress || d.senderEmail || d.creatorSMTPAddress].filter(Boolean).join(' '),
        to: byType('to'),
        cc: byType('cc'),
        date: d.messageDeliveryTime || d.clientSubmitTime || d.creationTime || null,
        subject: d.subject,
        body,
        attachments: attachments.filter(a => !isNoiseImage({ ...a, mime: resolveMime(a.mime, a.fileName) }))
    }, depth);
}

// ---- Entry point ----
// Returns { text, method } — throws UnsupportedFileError for file types that can't be read.
async function extractDocumentText(buffer, mime, fileName, depth = 0) {
    const type = resolveMime(mime, fileName);
    let result;
    if (type === 'application/pdf') result = await pdfToText(buffer, fileName);
    else if (GEMINI_NATIVE.has(type)) result = { text: (await transcribe(buffer, type, fileName)).text, method: 'ai-transcription' };
    else if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') result = { text: docxToText(buffer), method: 'docx' };
    else if (type === 'message/rfc822') result = { text: await emlToText(buffer, depth), method: 'email' };
    else if (type === 'application/vnd.ms-outlook') result = { text: await msgToText(buffer, depth), method: 'email' };
    else if (type === 'text/html') result = { text: htmlToText(buffer.toString('utf8')), method: 'text' };
    else if (type.startsWith('text/')) result = { text: buffer.toString('utf8'), method: 'text' };
    else throw new UnsupportedFileError(`File type not readable by AI (${type})`);

    let text = String(result.text || '').trim();
    if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Text cut off at ${MAX_TEXT_CHARS} characters]`;
    return { ...result, text };
}

module.exports = { extractDocumentText, UnsupportedFileError, htmlToText, rtfToText };
