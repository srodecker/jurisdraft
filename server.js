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

// Ensure root URL returns full.html (MUST be before static middleware)
app.get('/', (req, res) => {
    console.log('=== ROOT URL REQUEST ===');
    console.log('Request URL:', req.url);
    console.log('Request Path:', req.path);
    console.log('Sending file:', path.join(PUBLIC_DIR, 'full.html'));
    // Disable caching for development
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(path.join(PUBLIC_DIR, 'full.html'));
});

// Debug endpoint to check file content
app.get('/debug-file', async (req, res) => {
    try {
        const content = await fs.readFile(path.join(PUBLIC_DIR, 'full.html'), 'utf-8');
        const first500 = content.substring(0, 500);
        res.send(`<pre>${first500.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Serve static files with no-cache headers in development
app.use(express.static('public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
        }
    }
}));
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
let currentCourtReadyPDF = null;
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
    
    // 1. Convert to Title Case
    const lower = str.toLowerCase();
    const smallWords = ['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with'];
    let words = lower.split(/\s+/).map((word, index) => {
        if (index > 0 && smallWords.includes(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
    
    // 2. Force Acronyms to Uppercase
    // Add any other acronyms you want to preserve here
    const acronyms = ['LLP', 'LLC', 'PC', 'USA', 'INC', 'LTD', 'CORP'];
    words = words.map(word => {
        // Remove punctuation for comparison (e.g., "L.L.P.")
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (acronyms.includes(cleanWord)) {
            return cleanWord;
        }
        return word;
    });
    
    return words.join(' ');
}

/**
 * Process dynamic variables in the data object.
 * Refactored to globally sanitize FIRM_NAME.
 */
async function processDynamicVariables(data) {
    // --- GLOBAL SANITIZATION ---
    // Iterate through every key in the data object.
    // If a value is literally null, undefined, or the string "null", convert it to an empty string.
    Object.keys(data).forEach(key => {
        if (data[key] === null || data[key] === undefined || data[key] === 'null') {
            data[key] = '';
        }
    });
    
    // --- SANITIZE: LAST 4 DIGITS ONLY ---
    // Force DL and SSN fields to take only the last 4 characters, ignoring extra digits or spaces.
    const sanitizeLast4 = (val) => {
        if (!val) return '';
        const digits = String(val).replace(/\D/g, ''); // Remove non-digits
        return digits.slice(-4); // Take strictly the last 4
    };
    
    // Apply to Debtor 1
    if (data['[DEBTOR1_DL_LAST4]']) {
        data['[DEBTOR1_DL_LAST4]'] = sanitizeLast4(data['[DEBTOR1_DL_LAST4]']);
    }
    if (data['[DEBTOR1_SS_LAST4]']) {
        data['[DEBTOR1_SS_LAST4]'] = sanitizeLast4(data['[DEBTOR1_SS_LAST4]']);
    }
    
    // Apply to Debtor 2 (Mirror logic just in case)
    if (data['[DEBTOR2_DL_LAST4]']) {
        data['[DEBTOR2_DL_LAST4]'] = sanitizeLast4(data['[DEBTOR2_DL_LAST4]']);
    }
    if (data['[DEBTOR2_SS_LAST4]']) {
        data['[DEBTOR2_SS_LAST4]'] = sanitizeLast4(data['[DEBTOR2_SS_LAST4]']);
    }
    
    // Clean up and Title Case Debtor Address/City
    if (data['[DEBTOR1_ADDRESS]']) {
        // Strip trailing commas first, then Title Case
        let rawAddr = data['[DEBTOR1_ADDRESS]'].replace(/,\s*$/, '').trim();
        data['[DEBTOR1_ADDRESS]'] = toTitleCase(rawAddr);
    }
    
    if (data['[DEBTOR1_CITY]']) {
        data['[DEBTOR1_CITY]'] = toTitleCase(data['[DEBTOR1_CITY]']);
    }
    
    const attyName = data['[ATTY_NAME]'] || '';
    const firmName = data['[FIRM_NAME]'] || '';
    
    // --- FIX: Create a single, clean version of the firm name to use everywhere ---
    const formattedFirmName = toTitleCase(firmName);
    
    const firmAddress = data['[FIRM_ADDRESS]'] || '';
    const firmCity = data['[FIRM_CITY]'] || '';
    const firmState = data['[FIRM_STATE]'] || '';
    const firmZip = data['[FIRM_ZIP]'] || '';
    const firmPhone = data['[FIRM_PHONE]'] || '';
    const debtorZip = data['[DEBTOR1_ZIP]'] || '';
    
    // 1. FIX FIRM NAME GLOBALLY
    // Overwrite the raw ALL CAPS name with the Title Cased version
    if (formattedFirmName) {
        data['[FIRM_NAME]'] = formattedFirmName;
    }
    
    // 2. CREATE SPECIFIC ATTORNEY VARIABLES
    // VAR_ATTY1_NAME: "Name, SBN"
    if (attyName) {
        const sbn = data['[ATTY_SBN]'] || '';
        data['[VAR_ATTY1_NAME]'] = sbn ? `${attyName}, SBN: ${sbn}` : attyName;
    }
    
    // VAR_ATTY2_NAME: "Name, SBN" (Associate)
    const attyName2 = data['[ATTY_NAME2]'] || '';
    if (attyName2) {
        const sbn2 = data['[ATTY_SBN2]'] || '';
        data['[VAR_ATTY2_NAME]'] = sbn2 ? `${attyName2}, SBN: ${sbn2}` : attyName2;
    }
    
    // 3. CREATE VAR_CITY_STATE_ZIP
    // Format: "City, State Zip"
    if (firmCity && firmState && firmZip) {
        data['[VAR_CITY_STATE_ZIP]'] = `${firmCity}, ${firmState} ${firmZip}`;
    }
    
    // 4. SET UNKNOWN FLAGS FOR EMPTY DEBTOR IDENTIFIERS
    // If DL Last 4 is empty, mark it as unknown
    const debtorDL = data['[DEBTOR1_DL_LAST4]'];
    if (!debtorDL || debtorDL.trim() === '') {
        data['[IS_DEBTOR1_DL_UNKNOWN]'] = true;
    }
    
    // If SS Last 4 is empty, mark it as unknown
    const debtorSS = data['[DEBTOR1_SS_LAST4]'];
    if (!debtorSS || debtorSS.trim() === '') {
        data['[IS_DEBTOR1_SS_UNKNOWN]'] = true;
    }
    
    console.log('=== DEBTOR ZIP DEBUG ===');
    console.log('debtorZip value:', debtorZip);
    
    // Handle VAR_ATTY_NAME_WITH_ADDRESS
    if (attyName2 || formattedFirmName || firmAddress || firmCity) {
        // Clean attorney name: Remove "SBN" and numbers
        let cleanName = attyName2;
        if (attyName2) {
            // Remove SBN and everything after it
            const sbnIndex = attyName2.indexOf('SBN');
            if (sbnIndex !== -1) {
                cleanName = attyName2.substring(0, sbnIndex).trim();
            }
            // Remove any remaining numbers and trailing commas
            cleanName = cleanName.replace(/\d+/g, '').replace(/,\s*$/, '').trim();
            // Append ", Esq." to the cleaned name
            cleanName = cleanName + ', Esq.';
        }
        
        // Format the address with standardization
        const formattedAddress = standardizeAddress(firmAddress);
        
        // Build the parts array
        const parts = [];
        
        if (cleanName) parts.push(cleanName);
        // USE THE FORMATTED NAME HERE
        if (formattedFirmName) parts.push(formattedFirmName);
        
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
    const attorneys = [];
    const attySbn = data['[ATTY_SBN]'] || '';
    
    // 1. First Attorney
    if (attyName) {
        const attyWithSbn = attySbn ? `${attyName}, Esq., SBN ${attySbn}` : attyName;
        attorneys.push(attyWithSbn);
    }

    // 2. Second Attorney (Associate)
    const attySbn2 = data['[ATTY_SBN2]'] || '';
    
    if (attyName2) {
        const attyWithSbn2 = attySbn2 ? `${attyName2}, Esq., SBN ${attySbn2}` : attyName2;
        attorneys.push(attyWithSbn2);
        
        // Also set VAR_ATTY_NAME2 while we are here
        data['[VAR_ATTY_NAME2]'] = `${attyName2}, Esq.`;
    }
    
    // Check for additional attorney fields (3-10) just in case
    for (let i = 3; i <= 10; i++) {
        const additionalAttyName = data[`[ATTY_NAME${i}]`] || '';
        const additionalAttySbn = data[`[ATTY_SBN${i}]`] || '';
        
        if (additionalAttyName) {
            const attyWithSbn = additionalAttySbn 
                ? `${additionalAttyName}, Esq., SBN ${additionalAttySbn}` 
                : additionalAttyName;
            attorneys.push(attyWithSbn);
        }
    }
    
    if (attorneys.length > 0) {
        data['[VAR_ATTY_WITH_SBN]'] = attorneys.join('; ');
    }
    
    // Handle VAR_ATTY_EMAIL
    const attyEmail = data['[ATTY_EMAIL]'] || '';
    const attyEmail2 = data['[ATTY_EMAIL2]'] || '';
    const emails = [];
    if (attyEmail) emails.push(attyEmail);
    if (attyEmail2) emails.push(attyEmail2);
    if (emails.length > 0) {
        data['[VAR_ATTY_EMAIL]'] = emails.join(', ');
    }
    
    // Handle VAR_FIRM_FULL_ADDR
    if (formattedFirmName || firmAddress || firmCity) {
        const formattedAddress = standardizeAddress(firmAddress);
        const parts = [];
        
        // USE THE FORMATTED NAME HERE
        if (formattedFirmName) parts.push(formattedFirmName);
        
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
        
        const addressString = addressParts.join(', ');
        if (addressString) parts.push(addressString);
        
        const firmFullAddr = parts.join(' ');
        
        if (firmFullAddr) {
            data['[VAR_FIRM_FULL_ADDR]'] = firmFullAddr;
        }
    }
    
    // Handle VAR_DEFENDANT_WITH_DOES for SUM-100
    const defendantName = data['[DEFENDANT_NAME]'] || '';
    if (defendantName) {
        let cleanName = defendantName
            .replace(/,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i, '')
            .trim();
        
        data['[VAR_DEFENDANT_WITH_DOES]'] = `${cleanName}, an individual; and DOES 1 through 10, inclusive`;
    }
    
    // Handle VAR_DEFENDANT_NAME
    if (defendantName) {
        data['[VAR_DEFENDANT_NAME_ET_AL]'] = `${defendantName}, et al.`;
        // Mirror to page 2
        data['[DEFENDANT_NAME_P2]'] = data['[VAR_DEFENDANT_NAME_ET_AL]'];
    }
    
    // Handle VAR_DEFENDANT_NAME_WITH_ADDRESS
    if (defendantName) {
        const debtorAddress = data['[DEBTOR1_ADDRESS]'] || '';
        const debtorCity = data['[DEBTOR1_CITY]'] || '';
        const debtorState = data['[DEBTOR1_STATE]'] || '';
        const debtorZipForAddr = data['[DEBTOR1_ZIP]'] || '';
        
        const addressLine = `${defendantName}, an individual\n${debtorAddress}\n${debtorCity}, ${debtorState} ${debtorZipForAddr}`;
        data['[VAR_DEFENDANT_NAME_WITH_ADDRESS]'] = addressLine;
        
        // Handle VAR_DEFENDANT_SERVICE_ADDRESS (same as above but without "an individual" and no newlines)
        // Add period after street suffixes if missing
        let formattedDebtorAddress = debtorAddress;
        if (formattedDebtorAddress) {
            const streetSuffixes = ['St', 'Dr', 'Ter', 'Pl', 'Blvd', 'Ave', 'Rd', 'Ln', 'Ct', 'Cir', 'Pkwy', 'Way'];
            streetSuffixes.forEach(suffix => {
                // Match suffix at end of string or before a space, not already followed by a period
                const regex = new RegExp(`\\b${suffix}(?!\\.)\\b`, 'gi');
                formattedDebtorAddress = formattedDebtorAddress.replace(regex, suffix + '.');
            });
        }
        
        const serviceAddressParts = [defendantName + ',', formattedDebtorAddress + ',', `${debtorCity}, ${debtorState} ${debtorZipForAddr}`].filter(Boolean);
        data['[VAR_DEFENDANT_SERVICE_ADDRESS]'] = serviceAddressParts.join(' ');
    }
    
    // Handle VAR_COURTHOUSE and VAR_COURT_INFO based on debtor ZIP code
    if (debtorZip) {
        console.log('=== ENTERING ZIP LOOKUP ===');
        try {
            const { limitedCourts, courtInfo } = await loadCourtData();
            // Find the courthouse for this ZIP code
            const zipEntry = limitedCourts.find(row => row['Zip Code'] === debtorZip);
            
            if (zipEntry && zipEntry['Courthouse']) {
                const courthouseName = zipEntry['Courthouse'];
                data['[VAR_COURTHOUSE]'] = courthouseName;
                data['[COURT_BRANCH_NAME]'] = courthouseName;
                
                const courtEntry = courtInfo.find(row => row['Courthouse'] === courthouseName);
                
                if (courtEntry && courtEntry['Address']) {
                    const fullAddress = courtEntry['Address'];
                    data['[VAR_COURT_INFO]'] = fullAddress;
                    data['[COURT_DISTRICT]'] = courtEntry['District'] || '';
                    
                    const parts = fullAddress.split(',').map(p => p.trim());
                    
                    if (parts.length >= 3) {
                        const streetParts = parts.slice(0, -2);
                        data['[COURT_STREET_ADDRESS]'] = streetParts.join(', ');
                        data['[COURT_MAILING_ADDRESS]'] = streetParts.join(', ');
                        data['[COURT_CITY_ZIP]'] = parts[parts.length - 2] + ', ' + parts[parts.length - 1];
                    } else if (parts.length === 2) {
                        data['[COURT_STREET_ADDRESS]'] = parts[0];
                        data['[COURT_MAILING_ADDRESS]'] = parts[0];
                        data['[COURT_CITY_ZIP]'] = parts[1];
                    } else {
                        data['[COURT_STREET_ADDRESS]'] = fullAddress;
                        data['[COURT_MAILING_ADDRESS]'] = fullAddress;
                        data['[COURT_CITY_ZIP]'] = '';
                    }
                }
            } else {
                 console.log(`ZIP code ${debtorZip} not found in court database`);
                 data['[ZIP_NOT_FOUND]'] = true;
            }
        } catch (error) {
            console.error('Error loading court data:', error);
        }
    }
    
    // --- LOGIC: COURT MAILING ADDRESS ---
    // If mailing address is missing OR matches the street address, set specific text.
    const courtStreet = (data['[COURT_STREET_ADDRESS]'] || '').toLowerCase().trim();
    const courtMailing = (data['[COURT_MAILING_ADDRESS]'] || '').toLowerCase().trim();
    
    // Check if mailing is empty or effectively identical to street
    if (!courtMailing || courtMailing === courtStreet) {
        data['[COURT_MAILING_ADDRESS]'] = 'Same as street address';
    }
    
    // Handle VAR_CREDITOR1_NAME and VAR_CASE_NAME (reuse plaintiffName)
    const plaintiffName = data['[PLAINTIFF_NAME]'] || '';
    const defendantNameForCase = data['[DEFENDANT_NAME]'] || '';
    
    if (plaintiffName) {
        const creditorAddress = data['[CREDITOR_ADDRESS]'] || '';
        const creditorCity = data['[CREDITOR_CITY]'] || '';
        const creditorState = data['[CREDITOR_STATE]'] || '';
        const creditorZip = data['[CREDITOR_ZIP]'] || '';
        
        data['[VAR_CREDITOR1_NAME]'] = `${plaintiffName}\n${creditorAddress}\n${creditorCity}, ${creditorState} ${creditorZip}`;
    }
    
    // Handle VAR_COURT_COUNTY
    const courtCounty = data['[COURT_COUNTY]'] || '';
    if (courtCounty) {
        data['[VAR_COURT_COUNTY]'] = courtCounty.toUpperCase();
    }
    
    // Handle VAR_CASE_NAME
    if (plaintiffName && defendantNameForCase) {
        const formattedPlaintiff = toTitleCase(plaintiffName);
        const cleanDefendant = defendantNameForCase
            .replace(/,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i, '')
            .trim();
        const formattedDefendant = toTitleCase(cleanDefendant);
        
        const caseName = `${formattedPlaintiff} v. ${formattedDefendant}, et al.`;
        data['[VAR_CASE_NAME]'] = caseName;
        data['[CASE_NAME2]'] = caseName;
        data['[CASE_NAME3]'] = caseName;
        data['[CASE_NAME4]'] = caseName;
        data['[CASE_NAME5]'] = caseName;
    }
    
    // Handle IS_LIMITED and IS_UNLIMITED based on amount
    const demandAmount = data['[DEMAND_AMOUNT]'] || data['[JUDGMENT_TOTAL_AMOUNT]'] || '';
    let amount = 0;
    if (demandAmount) {
        const cleanAmount = demandAmount.replace(/[^0-9.]/g, '');
        amount = parseFloat(cleanAmount);
    }
    
    if (demandAmount && !isNaN(amount)) {
        if (amount <= 35000) {
            data['[IS_LIMITED]'] = true;
            data['[IS_UNLIMITED]'] = false;
        } else {
            data['[IS_UNLIMITED]'] = true;
            data['[IS_LIMITED]'] = false;
        }
    } else {
        data['[IS_LIMITED]'] = false;
        data['[IS_UNLIMITED]'] = false;
    }
    
    // Handle IS_BREACH_OF_CONTRACT_06
    const rawBreachOfContract = data['[RAW_IS_BREACH_OF_CONTRACT]'];
    if (rawBreachOfContract === true || String(rawBreachOfContract).toLowerCase() === 'true') {
        data['[IS_BREACH_OF_CONTRACT_06]'] = true;
        data['[IS_NOT_COMPLEX]'] = true;
        data['[IS_COMPLEX]'] = false;
        data['[IS_MONETARY]'] = true;
        data['[IS_NON_MONETARY]'] = false;
        data['[IS_NOT_CLASS_ACTION]'] = true;
        data['[IS_CLASS_ACTION]'] = false;
        data['[IS_REASON5]'] = true;
    }
    
    // Handle NUMBER_OF_CAUSES formatting
    const numWords = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE', 6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE', 10: 'TEN' };
    let rawCount = data['[NUMBER_OF_CAUSES]'];
    if (rawCount) {
        const countInt = parseInt(rawCount, 10);
        if (!isNaN(countInt) && numWords[countInt]) {
            data['[NUMBER_OF_CAUSES]'] = `${countInt} (${numWords[countInt]})`;
        }
    }
    
    // Handle Judgment Creditor Checkboxes
    // Check Names: Look at the Plaintiff and Creditor names
    const pNameLower = (data['[PLAINTIFF_NAME]'] || '').toLowerCase();
    const cNameLower = (data['[CREDITOR1_NAME]'] || '').toLowerCase();
    const combinedNames = pNameLower + ' ' + cNameLower;
    
    // Determine Status
    let isCreditor = true; // Default to True
    if (combinedNames.includes('assignee') || combinedNames.includes('successor') || combinedNames.includes('buyer')) {
        isCreditor = false;
    }
    
    // Apply to PDF Fields
    data['[IS_JUDGMENT_CREDITOR]'] = isCreditor;
    data['[IS_JUDGMENT_CREDITOR2]'] = isCreditor;
    data['[IS_ASSIGNEE_OF_RECORD]'] = !isCreditor;
    data['[IS_ASSIGNEE_OF_RECORD2]'] = !isCreditor;
    
    // Stay of Enforcement Logic (Item 11 - Negative Inference)
    // Look for stay date variables in the extracted data
    const stayDate = data['[STAY_DATE]'] || data['[STAY_ENFORCEMENT_DATE]'] || '';
    if (!stayDate || stayDate.trim() === '') {
        // If NO date is found (standard case): Set to True (maps to 'Not Ordered' checkbox, Item 11a)
        data['[IS_STAY_ORDERED]'] = true;
    } else {
        // If a date IS found: Set to False
        data['[IS_STAY_ORDERED]'] = false;
    }
    
    // Certification Logic (Item 12a - Standard certification)
    // Set to True by default for standard certification
    data['[IS_CERTIFIED_ABSTRACT]'] = true;
    
    // Mirror CASE_NUMBER to page 2
    if (data['[CASE_NUMBER]']) {
        data['[CASE_NUMBER_P2]'] = data['[CASE_NUMBER]'];
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
        
        // Store editable version in memory
        currentFilledPDF = Buffer.from(pdfBytes);
        currentPDFName = templateName.replace('.pdf', '_filled.pdf');
        
        // Create flattened court-ready version
        form.flatten();
        const flattenedPdfBytes = await pdfDoc.save();
        currentCourtReadyPDF = Buffer.from(flattenedPdfBytes);

        // Send back as base64 for preview
        const base64PDF = currentFilledPDF.toString('base64');
        
        res.json({ 
            success: true, 
            pdfData: base64PDF,
            filledFields: filledCount,
            totalFields: fields.length,
            availableFields: fieldInfo,
            processedData: data
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
        
        // Store editable version in memory
        currentFilledPDF = Buffer.from(pdfBytes);
        currentPDFName = templateName.replace('.pdf', '_filled.pdf');
        
        // Create flattened court-ready version
        form.flatten();
        const flattenedPdfBytes = await pdfDoc.save();
        currentCourtReadyPDF = Buffer.from(flattenedPdfBytes);

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
    const mode = req.query.mode; // 'court' for flattened version, undefined for editable
    
    let pdfToSend;
    let filename;
    
    if (mode === 'court') {
        if (!currentCourtReadyPDF) {
            return res.status(404).json({ error: 'No court-ready PDF available for download' });
        }
        pdfToSend = currentCourtReadyPDF;
        filename = currentPDFName.replace('_filled.pdf', '_court_ready.pdf');
    } else {
        if (!currentFilledPDF) {
            return res.status(404).json({ error: 'No PDF available for download' });
        }
        pdfToSend = currentFilledPDF;
        filename = currentPDFName;
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfToSend);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Add catch-all debug logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
