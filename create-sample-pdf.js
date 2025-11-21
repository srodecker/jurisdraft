const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs').promises;
const path = require('path');

async function createSamplePDF() {
    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    
    // Add a page
    const page = pdfDoc.addPage([600, 750]);
    const { width, height } = page.getSize();
    
    // Embed the Helvetica font
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Draw title
    page.drawText('Sample Contact Form', {
        x: 50,
        y: height - 50,
        size: 24,
        font: boldFont,
        color: rgb(0.2, 0.2, 0.6)
    });
    
    // Draw subtitle
    page.drawText('Please fill in your information', {
        x: 50,
        y: height - 80,
        size: 12,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
    });
    
    // Get the form
    const form = pdfDoc.getForm();
    
    // Create form fields
    let yPos = height - 140;
    const fields = [
        { name: 'firstName', label: 'First Name:' },
        { name: 'lastName', label: 'Last Name:' },
        { name: 'email', label: 'Email Address:' },
        { name: 'phone', label: 'Phone Number:' },
        { name: 'address', label: 'Street Address:' },
        { name: 'city', label: 'City:' },
        { name: 'state', label: 'State:' },
        { name: 'zipCode', label: 'ZIP Code:' },
        { name: 'country', label: 'Country:' },
        { name: 'comments', label: 'Comments/Notes:' }
    ];
    
    fields.forEach((field, index) => {
        // Draw label
        page.drawText(field.label, {
            x: 50,
            y: yPos,
            size: 11,
            font: boldFont,
            color: rgb(0, 0, 0)
        });
        
        // Create text field
        const textField = form.createTextField(field.name);
        textField.addToPage(page, {
            x: 180,
            y: yPos - 5,
            width: 350,
            height: 20,
            borderWidth: 1,
            borderColor: rgb(0.6, 0.6, 0.6)
        });
        
        yPos -= 50;
    });
    
    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(__dirname, 'templates', 'sample-form.pdf');
    await fs.writeFile(outputPath, pdfBytes);
    
    console.log(`Sample PDF created: ${outputPath}`);
    console.log('\nYou can fill this PDF with JSON like:');
    console.log(JSON.stringify({
        firstName: "John",
        lastName: "Doe",
        email: "john.doe@example.com",
        phone: "555-1234",
        address: "123 Main Street",
        city: "Springfield",
        state: "IL",
        zipCode: "62701",
        country: "USA",
        comments: "This is a sample form"
    }, null, 2));
}

createSamplePDF().catch(console.error);
