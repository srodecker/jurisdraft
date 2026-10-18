// Rename fields of a template in place (templates/<file>), for the current form engine.
//   node scripts/rename-template-fields.js "CM-010.pdf" templates/fixes/CM-010.json
// The JSON maps old name → new name. Renaming to a name another field already has (or two fields to
// the same new name) joins them into one field shown in several places, so they always show the same value.
// Positions, fonts and Acrobat scripts are kept.
// "_fontSize": { "[FIELD]": 10 } sets a fixed text size (instead of auto-size) in every place the field appears.
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString, PDFArray, PDFDict, PDFString } = require('pdf-lib');

// Entries that belong to the field, not to the box drawn on the page
const FIELD_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'AA', 'Opt', 'MaxLen'];

function topFields(doc) {
    return doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
}

// Turn a field into a list of widget refs it owns, detaching them from it
function widgetRefs(doc, ref) {
    const dict = doc.context.lookup(ref);
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) return kids.asArray();
    return [ref]; // field and widget are one dict
}

// One field named `name` with every box of `refs` (top-level field refs) as its widgets
function join(doc, name, refs) {
    const fields = topFields(doc);
    const firstDict = doc.context.lookup(refs[0]);
    const parent = doc.context.obj({});
    for (const k of FIELD_KEYS) { const v = firstDict.get(PDFName.of(k)); if (v) parent.set(PDFName.of(k), v); }
    if (firstDict.get(PDFName.of('DA'))) parent.set(PDFName.of('DA'), firstDict.get(PDFName.of('DA')));
    parent.set(PDFName.of('T'), PDFHexString.fromText(name));
    const parentRef = doc.context.register(parent);
    const kids = [];
    for (const ref of refs) {
        const own = doc.context.lookup(ref);
        const da = own.get(PDFName.of('DA'));
        for (const w of widgetRefs(doc, ref)) {
            const wd = doc.context.lookup(w);
            for (const k of FIELD_KEYS) wd.delete(PDFName.of(k));
            if (da && !wd.get(PDFName.of('DA'))) wd.set(PDFName.of('DA'), da);
            wd.delete(PDFName.of('Kids'));
            wd.set(PDFName.of('Parent'), parentRef);
            kids.push(w);
        }
        const i = fields.asArray().findIndex(x => x === ref);
        if (i >= 0) fields.remove(i);
    }
    parent.set(PDFName.of('Kids'), doc.context.obj(kids));
    fields.push(parentRef);
}

async function main() {
    const [file, mapFile] = process.argv.slice(2);
    if (!file || !mapFile) { console.error('Usage: node scripts/rename-template-fields.js "<template file>" <map.json>'); process.exit(1); }
    const target = path.join(__dirname, '..', 'templates', file);
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const doc = await PDFDocument.load(fs.readFileSync(target), { ignoreEncryption: true });
    const fields = topFields(doc);
    const nameOf = ref => { const t = doc.context.lookup(ref).get(PDFName.of('T')); return t ? t.decodeText() : ''; };

    // New name → top-level field refs that end up with it
    const groups = new Map();
    const missing = Object.keys(map).filter(k => !k.startsWith('_'));
    for (const ref of fields.asArray()) {
        const old = nameOf(ref);
        const name = old in map ? map[old] : old;
        if (old in map) missing.splice(missing.indexOf(old), 1);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(ref);
    }
    let renamed = 0, joined = 0;
    for (const [name, refs] of groups) {
        if (refs.length > 1) { join(doc, name, refs); joined++; continue; }
        if (nameOf(refs[0]) !== name) { doc.context.lookup(refs[0]).set(PDFName.of('T'), PDFHexString.fromText(name)); renamed++; }
    }
    for (const [name, size] of Object.entries(map._fontSize || {})) {
        const field = doc.getForm().getFieldMaybe(name);
        if (!field) { console.log('Font size: no field', name); continue; }
        const da = PDFString.of(`/Helv ${size} Tf 0 g`);
        for (const d of [field.acroField.dict, ...field.acroField.getWidgets().map(w => w.dict)]) d.set(PDFName.of('DA'), da);
    }
    fs.writeFileSync(target, await doc.save({ updateFieldAppearances: false }));
    console.log(`${file}: ${renamed} renamed, ${joined} joined`);
    if (missing.length) console.log('Not found in the PDF:', missing.join(', '));
}
main().catch(e => { console.error(e); process.exit(1); });
