require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

// Mount external routers
const extractRouter = require('./routes/extract');
app.use('/api', extractRouter);

// Store the current filled PDF in memory for preview and download
// NOTE: This is a simple in-memory storage suitable for single-user development/testing.
// LIMITATION: Multiple concurrent users will overwrite each other's PDFs (race condition).
// For production with multiple users, implement session-based storage (e.g., express-session),
// use Redis, or store files temporarily with unique user/session identifiers.
let currentFilledPDF = null;
let currentPDFName = null;

/**
 * Sanitize string values by replacing problematic characters that WinAnsi can't encode
 * @param {string} value - The string to sanitize
 * @returns {string} - Sanitized string compatible with WinAnsi encoding
 */
function sanitizeQuotes(value) {
    if (typeof value !== 'string') return value;
    
    return value
        // Replace curly/smart quotes with standard straight quotes
        .replace(/[\u201C\u201D]/g, '"')  // " and "
        .replace(/[\u2018\u2019]/g, "'") // ' and '
        // Replace Cyrillic and look-alike characters with Latin equivalents
        .replace(/[\u0410\u0430]/g, 'A') // Cyrillic A
        .replace(/[\u0412\u0432]/g, 'B') // Cyrillic B
        .replace(/[\u0415\u0435]/g, 'E') // Cyrillic E
        .replace(/[\u041A\u043A]/g, 'K') // Cyrillic K
        .replace(/[\u041C\u043C]/g, 'M') // Cyrillic M
        .replace(/[\u041D\u043D]/g, 'H') // Cyrillic H
        .replace(/[\u041E\u043E]/g, 'O') // Cyrillic O
        .replace(/[\u0420\u0440]/g, 'P') // Cyrillic P
        .replace(/[\u0421\u0441]/g, 'C') // Cyrillic C
        .replace(/[\u0422\u0442]/g, 'T') // Cyrillic T
        .replace(/[\u0425\u0445]/g, 'X') // Cyrillic X
        .replace(/[\u0423\u0443]/g, 'Y') // Cyrillic Y
        // Replace em/en dashes with hyphens
        .replace(/[\u2013\u2014]/g, '-')
        // Remove any remaining characters outside WinAnsi range (keep basic Latin + common symbols)
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

/**
 * Sanitize all string values in the data object
 * @param {Object} data - The JSON data object
 * @returns {Object} - Data object with sanitized string values
 */
function sanitizeAllValues(data) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        sanitized[key] = sanitizeQuotes(value);
    }
    return sanitized;
}

/**
 * Standardize address formatting with common abbreviations and proper capitalization
 * @param {string} address - The address string to standardize
 * @returns {string} - Standardized address
 */
function standardizeAddress(address) {
    if (!address || typeof address !== 'string') return address;
    
    let formatted = address;
    
    // Abbreviate common address suffixes (case-insensitive)
    const abbreviations = {
        '\\bCourt\\b': 'Ct.',
        '\\bSuite\\b': 'Ste.',
        '\\bStreet\\b': 'St.',
        '\\bAvenue\\b': 'Ave.',
        '\\bBoulevard\\b': 'Blvd.',
        '\\bFloor\\b': 'Fl.',
        '\\bDrive\\b': 'Dr.',
        '\\bRoad\\b': 'Rd.',
        '\\bLane\\b': 'Ln.',
        '\\bCircle\\b': 'Cir.',
        '\\bParkway\\b': 'Pkwy.'
    };
    
    for (const [pattern, abbrev] of Object.entries(abbreviations)) {
        formatted = formatted.replace(new RegExp(pattern, 'gi'), abbrev);
    }
    
    // Fix Mc/Mac capitalization (McDonald, MacArthur, etc.)
    formatted = formatted.replace(/\bMac([a-z])/gi, (match, letter) => 'Mac' + letter.toUpperCase());
    formatted = formatted.replace(/\bMc([a-z])/gi, (match, letter) => 'Mc' + letter.toUpperCase());
    
    return formatted;
}

/**
 * Process dynamic variables in the data object.
 * Currently handles:
 * - [VAR_ATTY_NAME_WITH_ADDRESS]: attorney name (without SBN), firm name, and firm city
 * - [VAR_ATTY_WITH_SBN]: attorney name(s) with SBN, semicolon-separated if multiple
 * - [VAR_FIRM_FULL_ADDR]: firm name, address, and city
 * @param {Object} data - The JSON data object containing field values
 * @returns {Object} - Modified data object with computed dynamic variables
 */
function processDynamicVariables(data) {
    const attyName = data['[ATTY_NAME]'] || '';
    const firmName = data['[FIRM_NAME]'] || '';
    const firmAddress = data['[FIRM_ADDRESS]'] || '';
    const firmCity = data['[FIRM_CITY]'] || '';
    const firmState = data['[FIRM_STATE]'] || '';
    const firmZip = data['[FIRM_ZIP]'] || '';
    const firmPhone = data['[FIRM_PHONE]'] || '';
    
    // Handle VAR_ATTY_NAME_WITH_ADDRESS
    if (attyName || firmName || firmAddress || firmCity) {
        // Clean attorney name: Remove "SBN" and numbers
        let cleanName = attyName;
        if (attyName) {
            // Remove SBN and everything after it
            const sbnIndex = attyName.indexOf('SBN');
            if (sbnIndex !== -1) {
                cleanName = attyName.substring(0, sbnIndex).trim();
            }
            // Remove any remaining numbers and trailing commas
            cleanName = cleanName.replace(/\d+/g, '').replace(/,\s*$/, '').trim();
        }
        
        // Format the address with standardization
        const formattedAddress = standardizeAddress(firmAddress);
        
        // Build the parts array (excluding address and city for now)
        const parts = [];
        
        if (cleanName) parts.push(cleanName);
        if (firmName) parts.push(firmName);
        
        // Add formatted address + comma + city/state/zip as one segment
        if (formattedAddress || firmCity) {
            const addressSegment = [];
            if (formattedAddress) addressSegment.push(formattedAddress);
            
            // Build city, state, zip
            const cityStateZip = [firmCity, firmState, firmZip]
                .filter(Boolean)
                .join(' ');
            
            if (cityStateZip) {
                // Add comma between address and city
                if (formattedAddress && cityStateZip) {
                    addressSegment.push(', ' + cityStateZip);
                } else if (cityStateZip) {
                    addressSegment.push(cityStateZip);
                }
            }
            
            if (addressSegment.length > 0) {
                parts.push(addressSegment.join(''));
            }
        }
        
        // Add phone at the end
        if (firmPhone) parts.push(firmPhone);
        
        // Combine all parts with single space separator
        const finalString = parts.join(' ');
        
        if (finalString) {
            data['[VAR_ATTY_NAME_WITH_ADDRESS]'] = finalString;
        }
    }
    
    // Handle VAR_ATTY_WITH_SBN
    // Collect all attorney names with their SBN numbers
    const attorneys = [];
    const attySbn = data['[ATTY_SBN]'] || '';
    
    if (attyName) {
        const attyWithSbn = attySbn ? `${attyName}, SBN: ${attySbn}` : attyName;
        attorneys.push(attyWithSbn);
    }
    
    // Check for additional attorney fields (ATTY_NAME2 + ATTY_SBN2, etc.)
    for (let i = 2; i <= 10; i++) {
        const additionalAttyName = data[`[ATTY_NAME${i}]`] || '';
        const additionalAttySbn = data[`[ATTY_SBN${i}]`] || '';
        
        if (additionalAttyName) {
            const attyWithSbn = additionalAttySbn 
                ? `${additionalAttyName}, SBN: ${additionalAttySbn}` 
                : additionalAttyName;
            attorneys.push(attyWithSbn);
        }
    }
    
    if (attorneys.length > 0) {
        data['[VAR_ATTY_WITH_SBN]'] = attorneys.join('; ');
    }
    
    // Handle VAR_FIRM_FULL_ADDR
    if (firmName || firmAddress || firmCity) {
        const firmLines = [];
        if (firmName) firmLines.push(firmName);
        if (firmAddress) firmLines.push(firmAddress);
        if (firmCity) firmLines.push(firmCity);
        
        data['[VAR_FIRM_FULL_ADDR]'] = firmLines.join('\n');
    }
    
    // Handle VAR_DEFENDANT_WITH_DOES for SUM-100
    const defendantName = data['[DEFENDANT_NAME]'] || '';
    if (defendantName) {
        // Strip out any existing legal suffixes to get clean name
        let cleanName = defendantName
            .replace(/,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i, '')
            .trim();
        
        data['[VAR_DEFENDANT_WITH_DOES]'] = `${cleanName}, an individual; and DOES 1 through 10, inclusive`;
    }
    
    return data;
}

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

        // Sanitize all values (replace curly quotes with standard quotes)
        data = sanitizeAllValues(data);

        // Process dynamic variables (e.g., VAR_ATTY_NAME_WITH_ADDRESS)
        data = processDynamicVariables(data);

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
        
        // Field info for debugging / returned to client
        const fieldInfo = fields.map(field => ({
            name: field.getName(),
            type: field.constructor ? field.constructor.name : typeof field
        }));

        // Build a lookup map for exact and case-insensitive names
        const fieldMap = {};
        fields.forEach(f => {
            const name = f.getName();
            fieldMap[name] = f;
            fieldMap[name.toLowerCase()] = f;
        });

        // Fill the form fields with data from JSON (try flexible matching)
        let filledCount = 0;
        for (const [key, value] of Object.entries(data)) {
            let field = fieldMap[key] || fieldMap[String(key).toLowerCase()];
            if (!field) {
                // Try partial match (suffix / contains) if exact not found
                field = fields.find(f => {
                    const n = f.getName();
                    return n === key || n.endsWith(key) || n.toLowerCase().includes(String(key).toLowerCase());
                });
            }
            if (!field) {
                console.log(`No field matched for JSON key: '${key}'`);
                continue;
            }

            try {
                // Prefer calling available methods rather than relying on constructor name
                if (typeof field.setText === 'function') {
                    field.setText(String(value));
                    filledCount++;
                } else if (typeof field.check === 'function' || typeof field.uncheck === 'function') {
                    // Treat truthy values as checked
                    const shouldCheck = value === true || value === 'true' || value === '1' || value === 1;
                    if (shouldCheck && typeof field.check === 'function') {
                        field.check();
                        filledCount++;
                    } else if (!shouldCheck && typeof field.uncheck === 'function') {
                        field.uncheck();
                    }
                } else if (typeof field.select === 'function') {
                    field.select(String(value));
                    filledCount++;
                } else {
                    console.log(`Unsupported field methods for '${field.getName()}'`);
                }
            } catch (err) {
                console.log(`Error filling field '${field.getName()}' (json key '${key}'): ${err.message}`);
            }
        }

        // Ensure appearances are updated so the filled text is visible.
        // Embed a standard font and update appearances before saving.
        try {
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            form.updateFieldAppearances(helvetica);
        } catch (err) {
            console.log('Warning: failed to update field appearances:', err.message);
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

// Auto-fill PDF with predefined dummy data
app.post('/api/auto-fill-pdf', async (req, res) => {
    const { templateName } = req.body;

    if (!templateName) {
        return res.status(400).json({ error: 'Template name is required' });
    }

    const dummyData = {
        "[ATTY_NAME]": "Auto Test Attorney",
        "[DEFENDANT_NAME]": "Auto Test Debtor",
        "[CASE_NUMBER]": "AUTO-TEST-123",
        "[JUDGMENT_TOTAL_AMOUNT]": "12345.67",
        // Add more realistic fields as needed
        "[ADDRESS]": "123 Auto Lane",
        "[CITY]": "Autoville",
        "[STATE]": "CA",
        "[ZIP_CODE]": "12345",
        "[PHONE_NUMBER]": "555-1234",
        "[EMAIL]": "auto@test.com"
    };

    // Sanitize all values (replace curly quotes with standard quotes)
    const sanitizedData = sanitizeAllValues(dummyData);

    // Process dynamic variables (e.g., VAR_ATTY_NAME_WITH_ADDRESS)
    const processedData = processDynamicVariables(sanitizedData);
    const jsonData = JSON.stringify(processedData);

    try {
        const templatePath = path.join(__dirname, 'templates', templateName);
        
        // Check if file exists
        await fs.access(templatePath);

        // Read the PDF template
        const existingPdfBytes = await fs.readFile(templatePath);
        
        // Load the PDF
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        
        // Get the form from the PDF
        const form = pdfDoc.getForm();
        const fields = form.getFields();
        
        // Field info for debugging / returned to client
        const fieldInfo = fields.map(field => ({
            name: field.getName(),
            type: field.constructor ? field.constructor.name : typeof field
        }));

        // Build a lookup map for exact and case-insensitive names
        const fieldMap = {};
        fields.forEach(f => {
            const name = f.getName();
            fieldMap[name] = f;
            fieldMap[name.toLowerCase()] = f;
        });

        // Fill the form fields with data from JSON (try flexible matching)
        let filledCount = 0;
        for (const [key, value] of Object.entries(JSON.parse(jsonData))) {
            let field = fieldMap[key] || fieldMap[String(key).toLowerCase()];
            if (!field) {
                // Try partial match (suffix / contains) if exact not found
                field = fields.find(f => {
                    const n = f.getName();
                    return n === key || n.endsWith(key) || n.toLowerCase().includes(String(key).toLowerCase());
                });
            }
            if (!field) {
                console.log(`No field matched for JSON key: '${key}'`);
                continue;
            }

            try {
                // Prefer calling available methods rather than relying on constructor name
                if (typeof field.setText === 'function') {
                    field.setText(String(value));
                    filledCount++;
                } else if (typeof field.check === 'function' || typeof field.uncheck === 'function') {
                    const shouldCheck = value === true || value === 'true' || value === '1' || value === 1;
                    if (shouldCheck && typeof field.check === 'function') {
                        field.check();
                        filledCount++;
                    } else if (!shouldCheck && typeof field.uncheck === 'function') {
                        field.uncheck();
                    }
                } else if (typeof field.select === 'function') {
                    field.select(String(value));
                    filledCount++;
                } else {
                    console.log(`Unsupported field methods for '${field.getName()}'`);
                }
            } catch (err) {
                console.log(`Error filling field '${field.getName()}' (json key '${key}'): ${err.message}`);
            }
        }

        // Ensure appearances are updated so the filled text is visible.
        try {
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            form.updateFieldAppearances(helvetica);
        } catch (err) {
            console.log('Warning: failed to update field appearances:', err.message);
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

// NOTE: The /api/extract route was moved to `routes/extract.js` for cleaner separation of concerns.

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

// Ensure root URL returns index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
