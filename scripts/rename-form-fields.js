// Rename a template's form fields to the v2 naming standard.
//   node scripts/rename-form-fields.js "CIV-100 (R4D).pdf"
// Reads templates/<file> and templates/v2/maps/<name>.json, writes templates/v2/<file>.
// Positions, fonts and Acrobat format scripts are kept; only the names change.
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');

async function main() {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node scripts/rename-form-fields.js "<template file>"'); process.exit(1); }
    const root = path.join(__dirname, '..', 'templates');
    const map = JSON.parse(fs.readFileSync(path.join(root, 'v2', 'maps', file.replace(/\.pdf$/i, '.json')), 'utf8'));
    const doc = await PDFDocument.load(fs.readFileSync(path.join(root, file)), { ignoreEncryption: true });
    const fields = doc.getForm().getFields();
    const seen = new Set(), unmapped = [];
    for (const f of fields) {
        const name = f.getName();
        if (!(name in map)) { if (/^\[/.test(name) && !/PRINT|SAVE|CLEAR/.test(name)) unmapped.push(name); continue; }
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
