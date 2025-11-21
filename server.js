const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting to prevent abuse
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Reasonable limit for JSON payloads
app.use(express.static('public'));
app.use('/api/', apiLimiter); // Apply rate limiting to all API routes

// Store the current filled PDF in memory for preview and download
// NOTE: This is a simple in-memory storage suitable for single-user development/testing.
// LIMITATION: Multiple concurrent users will overwrite each other's PDFs (race condition).
// For production with multiple users, implement session-based storage (e.g., express-session),
// use Redis, or store files temporarily with unique user/session identifiers.
let currentFilledPDF = null;
let currentPDFName = null;

// Get list of available PDF templates
app.get('/api/templates', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'templates'));
        const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
        res.json({ templates: pdfFiles });
    } catch (error) {
        console.error('Error reading templates:', error);
        res.status(500).json({ error: 'Failed to read templates' });
    }
});

// Fill PDF with provided JSON data
app.post('/api/fill-pdf', async (req, res) => {
    try {
        const { templateName, jsonData } = req.body;
        
        if (!templateName || !jsonData) {
            return res.status(400).json({ error: 'Template name and JSON data are required' });
        }

        // Parse JSON if it's a string
        let data;
        try {
            data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON format' });
        }

        const templatePath = path.join(__dirname, 'templates', templateName);
        
        // Check if file exists
        try {
            await fs.access(templatePath);
        } catch (error) {
            console.error('Template access error:', error);
            return res.status(404).json({ error: 'Template not found' });
        }

        // Read the PDF template
        const existingPdfBytes = await fs.readFile(templatePath);
        
        // Load the PDF
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        
        // Get the form from the PDF
        const form = pdfDoc.getForm();
        const fields = form.getFields();
        
        // Get field information for debugging
        const fieldInfo = fields.map(field => ({
            name: field.getName(),
            type: field.constructor.name
        }));

        // Fill the form fields with data from JSON
        let filledCount = 0;
        for (const [key, value] of Object.entries(data)) {
            try {
                const field = form.getField(key);
                const fieldType = field.constructor.name;
                
                if (fieldType === 'PDFTextField') {
                    field.setText(String(value));
                    filledCount++;
                } else if (fieldType === 'PDFCheckBox') {
                    if (value === true || value === 'true' || value === '1' || value === 1) {
                        field.check();
                        filledCount++;
                    } else {
                        field.uncheck();
                    }
                } else if (fieldType === 'PDFRadioGroup') {
                    field.select(String(value));
                    filledCount++;
                } else if (fieldType === 'PDFDropdown') {
                    field.select(String(value));
                    filledCount++;
                }
            } catch (error) {
                console.log(`Field '${key}' not found or error filling: ${error.message}`);
            }
        }

        // Save the filled PDF (keep form fields editable - don't flatten)
        const pdfBytes = await pdfDoc.save();
        
        // Store in memory for preview and download
        currentFilledPDF = Buffer.from(pdfBytes);
        currentPDFName = templateName.replace('.pdf', '_filled.pdf');

        // Send back as base64 for preview
        const base64PDF = currentFilledPDF.toString('base64');
        
        res.json({ 
            success: true, 
            pdfData: base64PDF,
            filledFields: filledCount,
            totalFields: fields.length,
            availableFields: fieldInfo
        });
    } catch (error) {
        console.error('Error filling PDF:', error);
        res.status(500).json({ error: 'Failed to fill PDF: ' + error.message });
    }
});

// Download the filled PDF
app.get('/api/download', (req, res) => {
    if (!currentFilledPDF) {
        return res.status(404).json({ error: 'No PDF available for download' });
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${currentPDFName}"`);
    res.send(currentFilledPDF);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
