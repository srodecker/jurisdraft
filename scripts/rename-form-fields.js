// Rename a template's form fields to the v2 naming standard.
//   node scripts/rename-form-fields.js "CIV-100 (R4D).pdf"
// Reads templates/<file> and templates/v2/maps/<name>.json, writes templates/v2/<file>.
// Positions, fonts and Acrobat format scripts are kept; only the names change.
//   _unnamed: Acrobat's own names ("Check Box12") → readable names, same as the main map
//   _widgets: "[OLD]@4" → "[NEW]": split the 4th place a shared field appears into its own field
//             (e.g. one date shown in five places, where one place must stay blank)
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString, PDFArray } = require('pdf-lib');

const INHERITED = ['FT', 'DA', 'Ff', 'Q', 'AA', 'MaxLen', 'TU'];

// Move one widget out of its field into a new field of its own
function splitWidget(doc, field, index, newName) {
    const kids = field.acroField.dict.lookup(PDFName.of('Kids'), PDFArray);
    if (!kids || index < 1 || index > kids.size()) throw new Error(`${field.getName()} has no place #${index}`);
    const ref = kids.get(index - 1);
    const widget = doc.context.lookup(ref);
    for (const k of INHERITED) {
        const v = field.acroField.dict.get(PDFName.of(k));
        if (v && !widget.has(PDFName.of(k))) widget.set(PDFName.of(k), v);
    }
    widget.delete(PDFName.of('Parent'));
    widget.set(PDFName.of('T'), PDFHexString.fromText(newName));
    kids.remove(index - 1);
    doc.getForm().acroForm.addField(ref);
}

async function main() {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node scripts/rename-form-fields.js "<template file>"'); process.exit(1); }
    const root = path.join(__dirname, '..', 'templates');
    const map = JSON.parse(fs.readFileSync(path.join(root, 'v2', 'maps', file.replace(/\.pdf$/i, '.json')), 'utf8'));
    const doc = await PDFDocument.load(fs.readFileSync(path.join(root, file)), { ignoreEncryption: true });
    const widgets = map._widgets || {};
    Object.assign(map, map._unnamed || {});
    // Split shared fields first, while their old names still match
    for (const [key, newName] of Object.entries(widgets)) {
        if (key.startsWith('_')) continue;
        const [oldName, n] = key.split('@');
        splitWidget(doc, doc.getForm().getField(oldName), Number(n), newName);
    }
    const fields = doc.getForm().getFields();
    const seen = new Set(), unmapped = [];
    for (const f of fields) {
        const name = f.getName();
        if (!(name in map)) { if (/^\[/.test(name) && !Object.values(widgets).includes(name) && !/PRINT|SAVE|CLEAR/.test(name)) unmapped.push(name); continue; }
        f.acroField.dict.set(PDFName.of('T'), PDFHexString.fromText(map[name]));
        seen.add(name);
    }
    const missing = Object.keys(map).filter(k => !k.startsWith('_') && !seen.has(k));
    fs.mkdirSync(path.join(root, 'v2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v2', file), await doc.save({ updateFieldAppearances: false }));
    console.log(`Renamed ${seen.size} fields → templates/v2/${file}`);
    if (unmapped.length) console.log('Bracket fields with no new name (left as is):', unmapped.join(', '));
    if (missing.length) console.log('Map entries not found in the PDF:', missing.join(', '));
}
main().catch(e => { console.error(e); process.exit(1); });
