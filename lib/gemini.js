// ============================================================
// Gemini helpers shared by routes
// ============================================================
const PizZip = require('pizzip');

const GEMINI_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const GEMINI_MODEL = 'gemini-2.5-flash';
// Inline request limit is ~20 MB after base64 (+33%); larger files go through the File API
const INLINE_MAX_BYTES = 14 * 1024 * 1024;

// Retry helper function with exponential backoff
async function fetchWithRetry(url, options, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(300000)
            });

            if (response.status === 503 || response.status === 429) {
                if (attempt < maxRetries) {
                    const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000);
                    console.log(`API returned ${response.status}, retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }

            return response;
        } catch (err) {
            if (attempt === maxRetries) throw err;

            const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000);
            console.log(`Request error (${err.name}), retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

function apiKey() {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('No GOOGLE_API_KEY configured. Document analysis requires the Gemini API.');
    return key;
}

// ------------------------------------------------------------
// File type handling
// ------------------------------------------------------------
const EXT_MIME = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/plain', rtf: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
const GEMINI_NATIVE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const DOCX_MIME = EXT_MIME.docx;

function resolveMime(mime, fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    if (EXT_MIME[ext]) return EXT_MIME[ext];
    return mime || 'application/octet-stream';
}

function decodeXmlEntities(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

function docxToText(buffer) {
    const zip = new PizZip(buffer);
    const xml = zip.file('word/document.xml');
    if (!xml) throw new Error('Not a valid .docx file');
    const text = xml.asText()
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '');
    return decodeXmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
}

// Upload a large file via the Gemini File API (resumable protocol)
async function uploadToFileApi(buffer, mime, displayName) {
    const key = apiKey();
    const start = await fetchWithRetry(`${GEMINI_BASE}/upload/v1beta/files?key=${key}`, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(buffer.length),
            'X-Goog-Upload-Header-Content-Type': mime,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: String(displayName || 'document').slice(0, 100) } })
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl) throw new Error(`Gemini file upload failed to start (HTTP ${start.status})`);

    const up = await fetchWithRetry(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(buffer.length),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: buffer
    });
    if (!up.ok) throw new Error(`Gemini file upload failed (HTTP ${up.status})`);
    let file = (await up.json()).file;

    // Wait until the file is processed
    for (let i = 0; file && file.state === 'PROCESSING' && i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await fetchWithRetry(`${GEMINI_BASE}/v1beta/${file.name}?key=${key}`, { method: 'GET' });
        file = await poll.json();
    }
    if (!file || file.state !== 'ACTIVE') throw new Error(`Gemini could not process the file (state: ${file ? file.state : 'unknown'})`);
    return { file_data: { mime_type: file.mimeType || mime, file_uri: file.uri } };
}

// Convert a stored file into Gemini request parts.
// Returns { parts } or { unsupported: 'reason' }.
async function fileToParts(buffer, mime, fileName) {
    const type = resolveMime(mime, fileName);
    if (GEMINI_NATIVE.has(type)) {
        if (buffer.length <= INLINE_MAX_BYTES) {
            return { parts: [{ inline_data: { mime_type: type, data: buffer.toString('base64') } }] };
        }
        return { parts: [await uploadToFileApi(buffer, type, fileName)] };
    }
    if (type === DOCX_MIME) {
        return { parts: [{ text: `--- Text of ${fileName} ---\n${docxToText(buffer)}` }] };
    }
    if (type.startsWith('text/')) {
        return { parts: [{ text: `--- Text of ${fileName} ---\n${buffer.toString('utf8')}` }] };
    }
    return { unsupported: `File type not readable by AI (${type})` };
}

// ------------------------------------------------------------
// Generation
// ------------------------------------------------------------
function parseJsonText(text) {
    let t = text || '{}';
    const match = t.match(/```json\s*([\s\S]*?)\s*```/) || t.match(/```\s*([\s\S]*?)\s*```/);
    if (match) t = match[1];
    return JSON.parse(t);
}

// Call Gemini and return the parsed JSON response
async function generateJson(parts, { maxOutputTokens = 16384 } = {}) {
    const url = `${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`;
    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.0, response_mime_type: 'application/json', maxOutputTokens }
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (HTTP ${response.status}): ${errText.slice(0, 300)}`);
    }
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    try {
        return parseJsonText(text);
    } catch (_) {
        const reason = result.candidates?.[0]?.finishReason;
        throw new Error(`Could not parse AI response${reason ? ` (finish reason: ${reason})` : ''}`);
    }
}

module.exports = { GEMINI_BASE, GEMINI_MODEL, fetchWithRetry, fileToParts, generateJson, resolveMime, docxToText };
