const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function listFields() {
    const pdfBytes = fs.readFileSync('templates/test-ej-001.pdf');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    
    console.log('Fields in new-ej-001.pdf:');
    fields.forEach(f => console.log(f.getName()));
}

listFields();