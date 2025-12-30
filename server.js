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

// Cache for CSV data to avoid reading files on every request
let limitedCourtsCache = null;
let courtInfoCache = null;

/**
 * Parse CSV content into an array of objects, handling quoted fields
 * @param {string} csvContent - The CSV file content
 * @returns {Array<Object>} - Array of objects with column headers as keys
 */
function parseCSV(csvContent) {
    const lines = csvContent.trim().split('\n');
    if (lines.length < 2) return [];
    
    // Helper function to parse a CSV line with quoted field support
    function parseLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                // Toggle quote state
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                // End of field
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        // Add the last field
        values.push(current.trim());
        
        return values;
    }
    
    const headers = parseLine(lines[0]);
    const rows = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = parseLine(lines[i]);
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        rows.push(row);
    }
    
    return rows;
}

/**
 * Load and cache CSV data
 * @returns {Promise<{limitedCourts: Array, courtInfo: Array}>}
 */
async function loadCourtData() {
    if (!limitedCourtsCache || !courtInfoCache) {
        const limitedCourtsPath = path.join(__dirname, 'data', 'Limited_Courts.csv');
        const courtInfoPath = path.join(__dirname, 'data', 'Court_Info.csv');
        
        const [limitedCourtsContent, courtInfoContent] = await Promise.all([
            fs.readFile(limitedCourtsPath, 'utf-8'),
            fs.readFile(courtInfoPath, 'utf-8')
        ]);
        
        limitedCourtsCache = parseCSV(limitedCourtsContent);
        courtInfoCache = parseCSV(courtInfoContent);
    }
    
    return {
        limitedCourts: limitedCourtsCache,
        courtInfo: courtInfoCache
    };
}

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
        // Replace Cyrillic and look-alike characters with Latin equivalents (preserving case)
        .replace(/\u0410/g, 'A') // Cyrillic A (uppercase)
        .replace(/\u0430/g, 'a') // Cyrillic a (lowercase)
        .replace(/\u0412/g, 'B') // Cyrillic B (uppercase)
        .replace(/\u0432/g, 'b') // Cyrillic b (lowercase)
        .replace(/\u0415/g, 'E') // Cyrillic E (uppercase)
        .replace(/\u0435/g, 'e') // Cyrillic e (lowercase)
        .replace(/\u041A/g, 'K') // Cyrillic K (uppercase)
        .replace(/\u043A/g, 'k') // Cyrillic k (lowercase)
        .replace(/\u041C/g, 'M') // Cyrillic M (uppercase)
        .replace(/\u043C/g, 'm') // Cyrillic m (lowercase)
        .replace(/\u041D/g, 'H') // Cyrillic H (uppercase)
        .replace(/\u043D/g, 'h') // Cyrillic h (lowercase)
        .replace(/\u041E/g, 'O') // Cyrillic O (uppercase)
        .replace(/\u043E/g, 'o') // Cyrillic o (lowercase)
        .replace(/\u0420/g, 'P') // Cyrillic P (uppercase)
        .replace(/\u0440/g, 'p') // Cyrillic p (lowercase)
        .replace(/\u0421/g, 'C') // Cyrillic C (uppercase)
        .replace(/\u0441/g, 'c') // Cyrillic c (lowercase)
        .replace(/\u0422/g, 'T') // Cyrillic T (uppercase)
        .replace(/\u0442/g, 't') // Cyrillic t (lowercase)
        .replace(/\u0425/g, 'X') // Cyrillic X (uppercase)
        .replace(/\u0445/g, 'x') // Cyrillic x (lowercase)
        .replace(/\u0423/g, 'Y') // Cyrillic Y (uppercase)
        .replace(/\u0443/g, 'y') // Cyrillic y (lowercase)
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
       
    return formatted;
}

/**
 * Convert a string to title case (capitalize first letter of each word)
 * @param {string} str - The string to convert
 * @returns {string} - Title cased string
 */
function toTitleCase(str) {
    if (!str || typeof str !== 'string') return str;
    
    // Convert to lowercase first
    const lower = str.toLowerCase();
    
    // Small words to keep lowercase (unless first word)
    const smallWords = ['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with'];
    
    // Split into words and capitalize appropriately
    const words = lower.split(/\s+/);
    
    return words.map((word, index) => {
        // Always capitalize first word
        if (index === 0) {
            return word.charAt(0).toUpperCase() + word.slice(1);
        }
        
        // Keep small words lowercase unless first word
        if (smallWords.includes(word)) {
            return word;
        }
        
        // Capitalize first letter of other words
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

/**
 * Process dynamic variables in the data object.
 * Currently handles:
 * - [VAR_ATTY_NAME_WITH_ADDRESS]: attorney name (without SBN), firm name, and firm city
 * - [VAR_ATTY_WITH_SBN]: attorney name(s) with SBN, semicolon-separated if multiple
 * - [VAR_FIRM_FULL_ADDR]: firm name, address, city, state, and zip as a single-line formatted string
 * - [VAR_CREDITOR1_NAME]: creditor name in title case with "Plaintiff, " prefix
 * - [VAR_COURT_COUNTY]: county name converted to uppercase
 * - [VAR_CASE_NAME]: formatted case name "Plaintiff v. Defendant, et al"
 * - [IS_LIMITED]: true if amount <= $35,000
 * - [IS_UNLIMITED]: true if amount > $35,000
 * - [IS_BREACH_OF_CONTRACT_06]: true if RAW_IS_BREACH_OF_CONTRACT is true
 * - CM-010 auto-fill: Sets IS_NOT_COMPLEX, IS_MONETARY, IS_NOT_CLASS_ACTION when breach of contract
 * - [VAR_COURTHOUSE]: courthouse name based on debtor ZIP code
 * - [VAR_COURT_INFO]: courthouse address based on debtor ZIP code
 * - [COURT_BRANCH_NAME]: courthouse branch name
 * - [COURT_STREET_ADDRESS]: parsed street address from courthouse address
 * - [COURT_MAILING_ADDRESS]: same as street address
 * - [COURT_CITY_ZIP]: parsed city, state, and zip from courthouse address
 * @param {Object} data - The JSON data object containing field values
 * @returns {Promise<Object>} - Modified data object with computed dynamic variables
 */
async function processDynamicVariables(data) {
    // Clean up DEBTOR1_ADDRESS - strip trailing commas
    if (data['[DEBTOR1_ADDRESS]']) {
        data['[DEBTOR1_ADDRESS]'] = data['[DEBTOR1_ADDRESS]'].replace(/,\s*$/, '').trim();
    }
    
    const attyName = data['[ATTY_NAME]'] || '';
    const firmName = data['[FIRM_NAME]'] || '';
    const firmAddress = data['[FIRM_ADDRESS]'] || '';
    const firmCity = data['[FIRM_CITY]'] || '';
    const firmState = data['[FIRM_STATE]'] || '';
    const firmZip = data['[FIRM_ZIP]'] || '';
    const firmPhone = data['[FIRM_PHONE]'] || '';
    const debtorZip = data['[DEBTOR1_ZIP]'] || '';
    
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
          
            // Build city, state, zip as "City, State Zip"
            const firmCityStateZip = formattedAddress + ', ' + firmCity + ', ' + firmState + ' ' + firmZip;
                        
            if (firmCityStateZip.length > 0) {
                parts.push(firmCityStateZip);
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
        // Use standardizeAddress helper on firm address
        const formattedAddress = standardizeAddress(firmAddress);
        
        // Build composite string: Firm Name Address, City, State Zip (single line)
        const parts = [];
        
        // Firm name gets no comma after it
        if (firmName) parts.push(firmName);
        
        // Address parts get joined with comma and space
        const addressParts = [];
        if (formattedAddress) addressParts.push(formattedAddress);
        if (firmCity) addressParts.push(firmCity);
        if (firmState && firmZip) {
            addressParts.push(firmState + ' ' + firmZip);
        } else if (firmState) {
            addressParts.push(firmState);
        } else if (firmZip) {
            addressParts.push(firmZip);
        }
        
        // Join address parts with comma and space
        const addressString = addressParts.join(', ');
        if (addressString) parts.push(addressString);
        
        // Join firm name and address with just a space
        const firmFullAddr = parts.join(' ');
        
        if (firmFullAddr) {
            data['[VAR_FIRM_FULL_ADDR]'] = firmFullAddr;
        }
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
    
    // Handle VAR_COURTHOUSE and VAR_COURT_INFO based on debtor ZIP code
    if (debtorZip) {
        try {
            const { limitedCourts, courtInfo } = await loadCourtData();
          console.log('Loading Zip code:', debtorZip);
            // Find the courthouse for this ZIP code
            const zipEntry = limitedCourts.find(row => row['Zip Code'] === debtorZip);
            
            if (zipEntry && zipEntry['Courthouse']) {
                const courthouseName = zipEntry['Courthouse'];
                data['[VAR_COURTHOUSE]'] = courthouseName;
                
                // Set COURT_BRANCH_NAME from the courthouse name
                data['[COURT_BRANCH_NAME]'] = courthouseName;
                
                // Find the address for this courthouse
                const courtEntry = courtInfo.find(row => row['Courthouse'] === courthouseName);
                
                if (courtEntry && courtEntry['Address']) {
                    const fullAddress = courtEntry['Address'];
                    data['[VAR_COURT_INFO]'] = fullAddress;
                    
                    // Extract district from Court_Info.csv
                    const district = courtEntry['District'] || '';
                    data['[COURT_DISTRICT]'] = district;
                    
                    // Parse the address into street and city/state/zip
                    // Expected format: "123 Main St, Los Angeles, CA 90012"
                    // Find the last comma that separates state from city
                    const parts = fullAddress.split(',').map(p => p.trim());
                    
                    if (parts.length >= 3) {
                        // Street is everything before the last two parts (city, state zip)
                        const streetParts = parts.slice(0, -2);
                        const streetAddress = streetParts.join(', ');
                        
                        // City and State Zip are the last two parts
                        const city = parts[parts.length - 2];
                        const stateZip = parts[parts.length - 1];
                        const cityStateZip = city + ', ' + stateZip;
                        
                        data['[COURT_STREET_ADDRESS]'] = streetAddress;
                        data['[COURT_MAILING_ADDRESS]'] = streetAddress;
                        data['[COURT_CITY_ZIP]'] = cityStateZip;
                    } else if (parts.length === 2) {
                        // Simple case: "Street, City State Zip"
                        data['[COURT_STREET_ADDRESS]'] = parts[0];
                        data['[COURT_MAILING_ADDRESS]'] = parts[0];
                        data['[COURT_CITY_ZIP]'] = parts[1];
                    } else {
                        // Fallback: treat entire address as street
                        data['[COURT_STREET_ADDRESS]'] = fullAddress;
                        data['[COURT_MAILING_ADDRESS]'] = fullAddress;
                        data['[COURT_CITY_ZIP]'] = '';
                    }
                }
            }
        } catch (error) {
            console.error('Error loading court data:', error);
        }
    }
    
    // Handle VAR_CREDITOR1_NAME
    const creditor1Name = data['[CREDITOR1_NAME]'] || '';
    if (creditor1Name) {
        const titleCasedName = toTitleCase(creditor1Name);
        data['[VAR_CREDITOR1_NAME]'] = 'Plaintiff, ' + titleCasedName;
    }
    
    // Handle VAR_COURT_COUNTY
    const courtCounty = data['[COURT_COUNTY]'] || '';
    if (courtCounty) {
        data['[VAR_COURT_COUNTY]'] = courtCounty.toUpperCase();
    }
    
    // Handle VAR_CASE_NAME
    const plaintiffName = data['[PLAINTIFF_NAME]'] || '';
    const defendantNameForCase = data['[DEFENDANT_NAME]'] || '';
    if (plaintiffName && defendantNameForCase) {
        // Apply title case to plaintiff
        const formattedPlaintiff = toTitleCase(plaintiffName);
        
        // Strip legal descriptions from defendant and apply title case
        const cleanDefendant = defendantNameForCase
            .replace(/,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i, '')
            .trim();
        const formattedDefendant = toTitleCase(cleanDefendant);
        
        // Construct case name
        const caseName = `${formattedPlaintiff} v. ${formattedDefendant}, et al.`;
        data['[VAR_CASE_NAME]'] = caseName;
        
        // Sync to all case name fields
        data['[CASE_NAME2]'] = caseName;
        data['[CASE_NAME3]'] = caseName;
        data['[CASE_NAME4]'] = caseName;
        data['[CASE_NAME5]'] = caseName;
    }
    
    // Handle IS_LIMITED and IS_UNLIMITED based on amount
    const demandAmount = data['[DEMAND_AMOUNT]'] || data['[JUDGMENT_TOTAL_AMOUNT]'] || '';
    if (demandAmount) {
        // Remove non-numeric characters and parse
        const cleanAmount = demandAmount.replace(/[^0-9.]/g, '');
        const amount = parseFloat(cleanAmount);
        
        if (!isNaN(amount)) {
            if (amount <= 35000) {
                data['[IS_LIMITED]'] = true;
                data['[IS_UNLIMITED]'] = false;
            } else {
                data['[IS_UNLIMITED]'] = true;
                data['[IS_LIMITED]'] = false;
            }
        } else {
            // Cannot parse amount, default both to false
            data['[IS_LIMITED]'] = false;
            data['[IS_UNLIMITED]'] = false;
        }
    } else {
        // No amount found, default both to false
        data['[IS_LIMITED]'] = false;
        data['[IS_UNLIMITED]'] = false;
    }
    
    // Handle IS_BREACH_OF_CONTRACT_06 based on RAW_IS_BREACH_OF_CONTRACT
    const rawBreachOfContract = data['[RAW_IS_BREACH_OF_CONTRACT]'];
    if (rawBreachOfContract === true || String(rawBreachOfContract).toLowerCase() === 'true') {
        data['[IS_BREACH_OF_CONTRACT_06]'] = true;
        
        // Auto-fill CM-010 fields for breach of contract cases
        data['[IS_NOT_COMPLEX]'] = true;
        data['[IS_COMPLEX]'] = false;
        data['[IS_MONETARY]'] = true;
        data['[IS_NON_MONETARY]'] = false;
        data['[IS_NOT_CLASS_ACTION]'] = true;
        data['[IS_CLASS_ACTION]'] = false;
        data['[IS_REASON5]'] = true;
    }
    
    // Handle NUMBER_OF_CAUSES formatting
    const numWords = {
        1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE',
        6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE', 10: 'TEN'
    };
    
    let rawCount = data['[NUMBER_OF_CAUSES]'];
    if (rawCount) {
        const countInt = parseInt(rawCount, 10);
        if (!isNaN(countInt) && numWords[countInt]) {
            data['[NUMBER_OF_CAUSES]'] = `${countInt} (${numWords[countInt]})`;
        }
        // If invalid, leave as raw value for safety
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
        data = await processDynamicVariables(data);

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

        // Embed fonts before filling loop
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

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
                    
                    // Apply font based on field type
                    if (key === '[VAR_COURT_COUNTY]') {
                        field.updateAppearances(helveticaBold);
                    } else {
                        field.updateAppearances(helvetica);
                    }
                    
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
    const processedData = await processDynamicVariables(sanitizedData);
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

        // Embed fonts before filling loop
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

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
                    
                    // Apply font based on field type
                    if (key === '[VAR_COURT_COUNTY]') {
                        field.updateAppearances(helveticaBold);
                    } else {
                        field.updateAppearances(helvetica);
                    }
                    
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
