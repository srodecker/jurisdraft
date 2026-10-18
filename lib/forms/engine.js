// ============================================================
// Forms v2 engine: fill any template whose fields follow the naming standard.
//
//   [FACT]                 the fact, formatted the way the PDF's own field format says (or plain)
//   [FACT:FORMAT:FORMAT]   the fact through one or more formats (see formatters.js)
//   [CHECK:CONDITION]      checkbox, checked when the condition holds (see dictionary.js)
//   [MANUAL:anything]      never filled automatically (fill by hand or with an override)
//   [PRESET:anything]      left exactly as the template has it
//   ...#2, #p2             suffix ignored: lets one fact appear in several separate fields
//
// No AI at fill time: the same case always produces the same form.
// ============================================================
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFString, PDFHexString, PDFStream } = require('pdf-lib');
const { FACTS, CONDITIONS, buildContext, empty } = require('./dictionary');
const { FORMATS, plain, formatFromScript } = require('./formatters');

const TEMPLATES_V2 = path.join(__dirname, '..', '..', 'templates', 'v2');

function parseFieldName(raw) {
    // Fields not written in [BRACKETS] (e.g. Acrobat's own "Check Box12", radio groups) are left as the template has them
    if (!/^\[/.test(String(raw).replace(/^.*\./, ''))) return { kind: 'preset' };
    const inner = String(raw).replace(/^.*\./, '').replace(/^\[|\]$/g, '').replace(/#[A-Za-z0-9_]+$/, '').trim();
    const parts = inner.split(':').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    if (parts[0] === 'CHECK') return { kind: 'check', condition: parts[1] || '' };
    if (parts[0] === 'MANUAL') return { kind: 'manual' };
    if (parts[0] === 'PRESET') return { kind: 'preset' };
    if (['PRINT', 'SAVE', 'CLEAR', 'CLEAR_FORM', 'RESET'].includes(parts[0])) return { kind: 'preset' };
    if (parts[0] === 'SIGNATURE' || parts[0] === 'ATTORNEY_SIGNATURE') return { kind: 'signature' };
    return { kind: 'fact', fact: parts[0], formats: parts.slice(1) };
}

function scriptText(doc, obj) {
    const o = doc.context.lookup(obj);
    if (!o) return '';
    if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
    if (o instanceof PDFStream) { try { return zlib.inflateSync(Buffer.from(o.contents)).toString(); } catch (_) { return Buffer.from(o.contents).toString(); } }
    return '';
}

// Every field: name, type and the format its own Acrobat format script asks for
async function inspectTemplate(buffer) {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const out = [];
    for (const f of doc.getForm().getFields()) {
        const name = f.getName();
        const type = typeof f.setText === 'function' ? 'text' : typeof f.check === 'function' ? 'checkbox' : typeof f.select === 'function' ? 'choice' : 'other';
        let script = '';
        for (const dict of [f.acroField.dict, ...f.acroField.getWidgets().map(w => w.dict)]) {
            const aa = doc.context.lookup(dict.get(PDFName.of('AA')));
            const fmt = aa && doc.context.lookup(aa.get(PDFName.of('F')));
            if (fmt) { script = scriptText(doc, fmt.get(PDFName.of('JS'))); break; }
        }
        let tooltip = '';
        try { const tu = f.acroField.dict.get(PDFName.of('TU')); if (tu) tooltip = tu.decodeText(); } catch (_) {}
        out.push({ name, type, tooltip, scriptFormat: formatFromScript(script), parsed: parseFieldName(name) });
    }
    return out;
}

// Value for one field. Returns { value, status: filled|missing|manual|preset|unknown, label }
function resolveField(field, ctx, overrides = {}) {
    const p = field.parsed;
    // A value typed for this exact field wins; a fact override ({ COSTS: '435' }) is formatted like the fact
    const ov = overrides[field.name];
    if (p.kind === 'check') {
        const cond = CONDITIONS[p.condition];
        if (ov !== undefined) return { value: ov === true || ov === 'true' || ov === '1', status: 'filled', label: cond ? cond.label : p.condition };
        if (!cond) return { value: null, status: 'unknown', label: `Unknown condition ${p.condition}` };
        return { value: !!cond.test(ctx), status: 'filled', label: cond.label };
    }
    if (p.kind !== 'fact') return { value: ov !== undefined ? ov : null, status: ov !== undefined ? 'filled' : p.kind, label: field.name };
    const def = FACTS[p.fact];
    if (ov !== undefined) return { value: String(ov), status: empty(ov) ? 'missing' : 'filled', label: def ? def.label : p.fact };
    if (!def) return { value: null, status: 'unknown', label: `Unknown fact ${p.fact}` };
    // A fact override (e.g. { COSTS: '435' }) applies before formatting
    const raw = overrides[p.fact] !== undefined ? overrides[p.fact] : def.get(ctx);
    if (empty(raw) || (Array.isArray(raw) && !raw.length)) return { value: '', status: 'missing', label: def.label };
    const formats = p.formats.length ? p.formats : (field.scriptFormat && !(def.type === 'text' && /^(MONEY|PLAIN)$/.test(field.scriptFormat)) ? [field.scriptFormat] : []);
    let value = raw;
    let asText = false;
    for (const f of formats) {
        const fn = FORMATS[f];
        if (!fn) return { value: '', status: 'unknown', label: `Unknown format ${f}` };
        value = fn(value);
        asText = true;
    }
    if (!asText) value = def.type === 'date' ? FORMATS.LONG(value) : plain(value);
    return { value: String(value), status: empty(value) ? 'missing' : 'filled', label: def.label };
}

// Resolve every field of a template
async function planTemplate(templatePath, ctx, overrides = {}) {
    const fields = await inspectTemplate(await fs.readFile(templatePath));
    const values = {}, report = [], bold = [];
    for (const f of fields) {
        const r = resolveField(f, ctx, overrides);
        report.push({ field: f.name, type: f.type, ...r });
        if (r.status === 'filled' && r.value !== null) values[f.name] = r.value;
        if (f.parsed.kind === 'fact' && f.parsed.formats.includes('BOLD')) bold.push(f.name);
    }
    return { fields, values, report, bold };
}

function v2TemplatePath(file) { return path.join(TEMPLATES_V2, file); }
async function hasV2Template(file) { try { await fs.access(v2TemplatePath(file)); return true; } catch (_) { return false; } }

// Fill a v2 template. fillPdf = the PDF writer (services.fillPdfTemplate with raw mode)
async function fillTemplateV2(file, { matter, fd, profile, today, signer, overrides, session, fillPdf }) {
    const ctx = buildContext({ matter, fd, profile, today, signer });
    const plan = await planTemplate(v2TemplatePath(file), ctx, overrides);
    const r = await fillPdf(file, plan.values, session, { raw: true, templatesDir: TEMPLATES_V2, boldFields: plan.bold });
    const missing = [...new Set(plan.report.filter(x => x.status === 'missing').map(x => x.label))];
    const unknown = plan.report.filter(x => x.status === 'unknown').map(x => `${x.field} (${x.label})`);
    return { ...r, values: plan.values, report: plan.report, missing, unknown };
}

module.exports = { parseFieldName, inspectTemplate, resolveField, planTemplate, fillTemplateV2, hasV2Template, v2TemplatePath, TEMPLATES_V2 };
