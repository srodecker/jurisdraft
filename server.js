require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const execAsync = util.promisify(exec);

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Cache for CSV data to avoid reading files on every request
let jurisdictionRulesCache = null;
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
 * Load and cache CSV data from Jurisdiction_Rules and Court_Info
 * @returns {Promise<{jurisdictionRules: Array, courtInfo: Array}>}
 */
async function loadCourtData() {
    if (!jurisdictionRulesCache || !courtInfoCache) {
        const jurisdictionRulesPath = path.join(__dirname, 'data', 'Jurisdiction_Rules.csv');
        const courtInfoPath = path.join(__dirname, 'data', 'Court_Info.csv');

        const [jurisdictionRulesContent, courtInfoContent] = await Promise.all([
            fs.readFile(jurisdictionRulesPath, 'utf-8'),
            fs.readFile(courtInfoPath, 'utf-8')
        ]);

        jurisdictionRulesCache = parseCSV(jurisdictionRulesContent);
        courtInfoCache = parseCSV(courtInfoContent);
    }

    return {
        jurisdictionRules: jurisdictionRulesCache,
        courtInfo: courtInfoCache
    };
}

/**
 * Normalize court name for fuzzy matching
 * @param {string} name - The court name to normalize
 * @returns {string} - Normalized court name
 */
function normalizeCourtName(name) {
    return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Determine the appropriate court based on ZIP code, demand amount, and optional city selection
 * @param {string} zipCode - The debtor's ZIP code
 * @param {number|string} demandAmount - The demand amount (determines Limited vs Unlimited)
 * @param {string|null} citySelection - Optional city/condition selection for geographic splits or venue choice
 * @returns {Promise<Object>} - Court determination result
 */
async function determineCourt(zipCode, demandAmount, citySelection = null) {
    const { jurisdictionRules, courtInfo } = await loadCourtData();

    // Step 1: Parse amount and determine case type
    // Limited if demandAmount <= 35000, else Unlimited
    // Default to Unlimited if amount is missing/null
    let amount = 0;
    if (demandAmount) {
        const cleanAmount = String(demandAmount).replace(/[^0-9.]/g, '');
        amount = parseFloat(cleanAmount);
    }
    const caseType = (!isNaN(amount) && amount > 0 && amount <= 35000) ? 'Limited' : 'Unlimited';

    // Step 2: Filter rows where ZipCode matches AND CaseType matches
    const matches = jurisdictionRules.filter(row =>
        row['ZipCode'] === zipCode && row['CaseType'] === caseType
    );

    // Step 3: Decision tree based on number of matches
    if (matches.length === 0) {
        // No matches - ZIP not supported for this case type
        return {
            success: false,
            error: `ZIP code ${zipCode} not found in court database for ${caseType} cases`,
            caseType: caseType.toLowerCase()
        };
    }

    if (matches.length === 1) {
        // Single match - auto-fill court
        const match = matches[0];
        const courtName = match['CourtName'];

        if (!courtName || courtName === 'nan' || courtName.trim() === '') {
            return {
                success: false,
                error: `No court assigned for ZIP code ${zipCode} (${caseType} cases)`,
                caseType: caseType.toLowerCase()
            };
        }

        // Look up court details in Court_Info
        const courtEntry = courtInfo.find(row =>
            normalizeCourtName(row['Courthouse']) === normalizeCourtName(courtName)
        );

        return {
            success: true,
            courtName: courtName,
            courtAddress: courtEntry ? courtEntry['Address'] : '',
            courtDistrict: courtEntry ? courtEntry['District'] : '',
            caseType: caseType.toLowerCase()
        };
    }

    // Multiple matches - check if this is a geographic split or venue choice
    const hasConditions = matches.some(row => row['Condition'] && row['Condition'].trim() !== '');

    if (hasConditions) {
        // Geographic Split - MANDATORY selection based on Condition
        if (citySelection) {
            // User has made a selection - find matching entry
            const matchedEntry = matches.find(row => row['Condition'] === citySelection);
            if (matchedEntry) {
                const courtName = matchedEntry['CourtName'];
                const courtEntry = courtInfo.find(row =>
                    normalizeCourtName(row['Courthouse']) === normalizeCourtName(courtName)
                );

                return {
                    success: true,
                    courtName: courtName,
                    courtAddress: courtEntry ? courtEntry['Address'] : '',
                    courtDistrict: courtEntry ? courtEntry['District'] : '',
                    caseType: caseType.toLowerCase()
                };
            }
        }

        // No selection or invalid selection - return options
        const options = matches.map(row => row['Condition']).filter(c => c && c.trim() !== '');
        return {
            success: false,
            needsSelection: true,
            type: 'split',
            options: options,
            caseType: caseType.toLowerCase()
        };
    } else {
        // Venue Choice - OPTIONAL selection with default
        if (citySelection) {
            // User has made a selection - find matching entry by court name
            const matchedEntry = matches.find(row => row['CourtName'] === citySelection);
            if (matchedEntry) {
                const courtName = matchedEntry['CourtName'];
                const courtEntry = courtInfo.find(row =>
                    normalizeCourtName(row['Courthouse']) === normalizeCourtName(courtName)
                );

                return {
                    success: true,
                    courtName: courtName,
                    courtAddress: courtEntry ? courtEntry['Address'] : '',
                    courtDistrict: courtEntry ? courtEntry['District'] : '',
                    caseType: caseType.toLowerCase()
                };
            }
        }

        // Return venue choice options with default
        const options = matches.map(row => row['CourtName']);
        const defaultEntry = matches.find(row => row['Is_Default'] === 'True');
        const defaultOption = defaultEntry ? defaultEntry['CourtName'] : options[0];

        return {
            success: false,
            needsSelection: true,
            type: 'choice',
            options: options,
            defaultOption: defaultOption,
            caseType: caseType.toLowerCase()
        };
    }
}

// Rate limiting to prevent abuse
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Reasonable limit for JSON payloads

// Resolve LibreOffice binary path for environments without global PATH setup
async function resolveSofficePath() {
    const candidates = [
        process.env.SOFFICE_PATH,
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            // Set env var used by libreoffice-convert for extra safety
            if (!process.env.LIBRE_OFFICE_EXE) {
                process.env.LIBRE_OFFICE_EXE = candidate;
            }
            return candidate;
        } catch (error) {
            // Try next candidate
        }
    }

    return null;
}

// Root URL returns landing page
app.get('/', (req, res) => {
    console.log('=== ROOT URL REQUEST (Landing Page) ===');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    console.log('Serving landing page from:', path.join(PUBLIC_DIR, 'landing.html'));
    res.sendFile(path.join(PUBLIC_DIR, 'landing.html'), { dotfiles: 'allow' });
});

// Main workspace route
app.get('/full', (req, res) => {
    console.log('=== FULL WORKSPACE REQUEST ===');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(path.join(PUBLIC_DIR, 'full.html'), { dotfiles: 'allow' });
});

// Extraction workspace route (legacy - redirects to /full)
app.get('/extract', (req, res) => {
    console.log('=== EXTRACT WORKSPACE REQUEST ===');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(path.join(PUBLIC_DIR, 'full.html'), { dotfiles: 'allow' });
});

// Serve static files with no-cache headers in development
app.use(express.static('public', {
    dotfiles: 'allow',
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
        // Also create VAR_FIRM_FULL_NAME as title case version
        data['[VAR_FIRM_FULL_NAME]'] = formattedFirmName;
        data['[VAR_FIRM_FULL_NAME_CAPITAL]'] = formattedFirmName.toUpperCase();
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
        data['[VAR_CAPITAL_ATTY_NAME2]'] = attyName2.toUpperCase();
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
        
        // Also create VAR_FIRM_FULL_ADDR_NO_FIRM (address only, no firm name)
        if (addressString) {
            data['[VAR_FIRM_FULL_ADDR_NO_FIRM]'] = addressString;
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
        let cleanName = defendantName
            .replace(/,\s*(an individual|a corporation|a limited liability company|an LLC|a partnership|a sole proprietorship|etc\.?)$/i, '')
            .trim();
        data['[VAR_DEFENDANT_NAME]'] = cleanName;
        data['[VAR_DEFENDANT_NAME_ET_AL]'] = `${cleanName}, et al.`;
        data['[VAR_DEFENDANT_INDIVIDUAL]'] = `${cleanName}, an individual`;
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
        
        // Also create version without ", an individual"
        const addressLineNoIndividual = `${defendantName}\n${debtorAddress}\n${debtorCity}, ${debtorState} ${debtorZipForAddr}`;
        data['[VAR_DEFENDANT_NAME_WITH_ADDRESS_NO_INDIVIDUAL]'] = addressLineNoIndividual;
        
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
            // Get demand amount for case type determination
            const lookupDemandAmount = data['[DEMAND_AMOUNT]'] || data['[JUDGMENT_TOTAL_AMOUNT]'] || '';
            // Get city selection if provided (for special cases with multiple courts per ZIP)
            const citySelection = data['[COURT_CITY_SELECTION]'] || null;

            const courtResult = await determineCourt(debtorZip, lookupDemandAmount, citySelection);

            if (courtResult.success) {
                // Court resolved successfully
                const courthouseName = courtResult.courtName;
                data['[VAR_COURTHOUSE]'] = courthouseName;
                data['[COURT_BRANCH_NAME]'] = courthouseName;

                if (courtResult.courtAddress) {
                    const fullAddress = courtResult.courtAddress;
                    data['[VAR_COURT_INFO]'] = fullAddress;
                    data['[COURT_DISTRICT]'] = courtResult.courtDistrict || '';

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
            } else if (courtResult.needsSelection) {
                // Multiple courts available for this ZIP - user needs to select
                console.log(`ZIP code ${debtorZip} requires court selection from options:`, courtResult.options);
                data['[NEED_COURT_SELECTION]'] = true;
                data['[COURT_OPTIONS]'] = courtResult.options;
            } else {
                // ZIP not found
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
    
    // Create VAR_PLAINTIFF_NAME as title case version with "Plaintiff, " prefix
    if (plaintiffName) {
        const formattedPlaintiffName = toTitleCase(plaintiffName);
        data['[VAR_PLAINTIFF_NAME]'] = `Plaintiff, ${formattedPlaintiffName}`;
    }
    
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
            data['[VAR_UNLIMITED_OR_LIMITED]'] = 'Limited Civil Case';
        } else {
            data['[IS_UNLIMITED]'] = true;
            data['[IS_LIMITED]'] = false;
            data['[VAR_UNLIMITED_OR_LIMITED]'] = 'Unlimited Civil Case';
        }
    } else {
        data['[IS_LIMITED]'] = false;
        data['[IS_UNLIMITED]'] = false;
        data['[VAR_UNLIMITED_OR_LIMITED]'] = '';
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

// Court lookup API endpoint
app.get('/api/court-lookup', async (req, res) => {
    try {
        const { zip, amount, citySelection } = req.query;

        if (!zip) {
            return res.status(400).json({ error: 'ZIP code is required' });
        }

        const result = await determineCourt(zip, amount, citySelection || null);
        res.json(result);
    } catch (error) {
        console.error('Error in court lookup:', error);
        res.status(500).json({ error: 'Failed to lookup court: ' + error.message });
    }
});

// Get list of available PDF and DOCX templates
app.get('/api/templates', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'templates'));
        const templateFiles = files.filter(file => {
            const ext = file.toLowerCase();
            return ext.endsWith('.pdf') || ext.endsWith('.docx');
        });
        res.json({ templates: templateFiles });
    } catch (error) {
        console.error('Error reading templates:', error);
        res.status(500).json({ error: 'Failed to read templates' });
    }
});

// Serve raw template files (for docx preview and PDF inline viewing)
app.get('/api/fetch-template/:filename', (req, res) => {
    const filename = req.params.filename;
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(__dirname, 'templates', filename);
    
    // For PDFs, explicitly set headers to force inline display (prevent download prompt)
    if (filename.toLowerCase().endsWith('.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }
    
    res.sendFile(filePath);
});

async function convertDocxToPdf(docxBuffer) {
    const sofficePath = await resolveSofficePath();
    if (!sofficePath) {
        throw new Error('Could not find soffice binary');
    }

    const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const inputPath = path.join(os.tmpdir(), `temp_${id}.docx`);
    const outDir = os.tmpdir();
    const outputPath = path.join(outDir, `temp_${id}.pdf`);

    try {
        await fs.writeFile(inputPath, docxBuffer);

        const command = `"${sofficePath}" --headless --convert-to pdf --outdir "${outDir}" "${inputPath}"`;

        try {
            await execAsync(command);
        } catch (error) {
            if (error && error.stderr) {
                console.error('LibreOffice stderr:', error.stderr);
            }
            throw error;
        }

        const pdfBuffer = await fs.readFile(outputPath);
        return pdfBuffer;
    } finally {
        try { await fs.unlink(inputPath); } catch (error) { /* ignore */ }
        try { await fs.unlink(outputPath); } catch (error) { /* ignore */ }
    }
}

// Preview DOCX as PDF (using LibreOffice conversion)
app.get('/api/preview-docx/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        // Security: prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        const filePath = path.join(__dirname, 'templates', filename);
        const docxBuffer = await fs.readFile(filePath);
        
        console.log(`Converting ${filename} to PDF for preview...`);
        
        // Convert DOCX to PDF using LibreOffice
        const pdfBuffer = await convertDocxToPdf(docxBuffer);
        
        console.log(`Conversion complete: ${pdfBuffer.length} bytes`);
        
        // Send PDF for preview
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename.replace('.docx', '.pdf')}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Error converting DOCX to PDF:', error);
        res.status(500).json({ error: 'Failed to convert DOCX: ' + error.message });
    }
});

// Preview filled DOCX as PDF (using LibreOffice conversion)
// Uses the same robust filling logic as /api/fill-docx
app.post('/api/preview-filled-docx', async (req, res) => {
    try {
        const { templateName, jsonData } = req.body;
        
        if (!templateName || !jsonData) {
            return res.status(400).json({ error: 'Template name and JSON data are required' });
        }
        
        // Security: prevent path traversal
        if (templateName.includes('..') || templateName.includes('/') || templateName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        // Parse JSON if it's a string
        let data;
        try {
            data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON format' });
        }

        // Normalize keys: support both "[VAR]" and "VAR" formats
        const normalizedData = normalizeDocxData(data);

        const filePath = path.join(__dirname, 'templates', templateName);
        const content = await fs.readFile(filePath);
        
        // Load the docx file
        let zip = new PizZip(content);
        
        // Repair XML to fix Word's tag splitting issues (same as /api/fill-docx)
        zip = repairDocxZip(zip);
        
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            // Use square bracket delimiters (same as /api/fill-docx)
            delimiters: { start: '[', end: ']' },
            nullGetter: function(part) {
                if (!part.module) return '[' + part.value + ']';
                if (part.module === 'loop') return [];
                return '[' + part.value + ']';
            }
        });
        
        doc.render(normalizedData);
        
        // Generate filled DOCX buffer
        const filledDocxBuffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
        
        console.log(`Converting filled ${templateName} to PDF for preview...`);
        
        // Convert to PDF for preview
        const pdfBuffer = await convertDocxToPdf(filledDocxBuffer);
        
        // Return as base64 for the frontend
        const base64PDF = pdfBuffer.toString('base64');
        
        res.json({
            success: true,
            pdfData: base64PDF
        });
    } catch (error) {
        console.error('Error previewing filled DOCX:', error);
        res.status(500).json({ error: 'Failed to preview: ' + error.message });
    }
});

// ============================================================================
// ============================================================================
// DOCX HANDLING - "TEXT MAPPING" SURGICAL QUOTE REMOVAL
// ============================================================================
// 
// Word splits variables across multiple <w:t> nodes. This strategy uses DOM
// parsing and text mapping to surgically remove quote characters from the
// exact XML nodes that contain them.
//
// TEXT MAPPING STRATEGY:
//   Step 1: BUILD THE MAP - Parse XML, extract all <w:t> nodes, track positions
//   Step 2: FIND TARGETS - Search concatenated text for "[VAR]" patterns
//   Step 3: SURGICAL DELETION - Mutate specific nodes to remove quote chars
//   Step 4: SERIALIZE - Convert modified DOM back to XML string
//
// Only quoted variables are detected for filling:
// - "[VAR_NAME]" → Detected, quotes surgically removed, variable preserved
// - [PROPOSED]   → Ignored (no quotes), preserved as literal text
// ============================================================================

const WORDML_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * Build a text map from all <w:t> nodes in the document.
 * Each entry tracks the node, its text, and its position in the full text.
 * 
 * @param {Document} doc - Parsed XML document
 * @returns {{fullText: string, textMap: Array}} - Full text and position map
 */
function buildTextMap(doc) {
    const textMap = [];
    const wTElements = doc.getElementsByTagNameNS(WORDML_NS, 't');
    
    let fullText = '';
    
    for (let i = 0; i < wTElements.length; i++) {
        const node = wTElements[i];
        const text = node.textContent || '';
        const startIndex = fullText.length;
        fullText += text;
        const endIndex = fullText.length;
        
        textMap.push({
            node,
            text,
            startIndex,
            endIndex
        });
    }
    
    return { fullText, textMap };
}

/**
 * Find all quoted variables in the full text.
 * Returns detailed info about each match including quote positions.
 * 
 * Pattern: "[VAR_NAME]" or "[VAR_NAME]" (curly quotes)
 * 
 * @param {string} fullText - Concatenated text from all <w:t> nodes
 * @returns {Array} - Array of match objects with position info
 */
function findQuotedVariablesWithPositions(fullText) {
    // Pattern captures: (openQuote) [ (varName) ] (closeQuote)
    const pattern = /([""\u201C\u201D])(\[)([A-Za-z][A-Za-z0-9_]*)(\])([""\u201C\u201D])/g;
    const matches = [];
    let match;
    
    while ((match = pattern.exec(fullText)) !== null) {
        const openQuote = match[1];
        const openBracket = match[2];
        const varName = match[3];
        const closeBracket = match[4];
        const closeQuote = match[5];
        
        // Calculate exact positions for each part
        const openQuoteStart = match.index;
        const openQuoteEnd = openQuoteStart + openQuote.length;
        
        const closeQuoteStart = openQuoteEnd + openBracket.length + varName.length + closeBracket.length;
        const closeQuoteEnd = closeQuoteStart + closeQuote.length;
        
        matches.push({
            varName: varName.toUpperCase(),
            fullMatch: match[0],
            openQuoteIndex: openQuoteStart,
            closeQuoteIndex: closeQuoteStart,
            // Store the actual quote characters for accurate deletion
            openQuoteChar: openQuote,
            closeQuoteChar: closeQuote
        });
    }
    
    return matches;
}

/**
 * Find which text node contains a specific character index.
 * Returns the node and the local offset within that node.
 * 
 * @param {Array} textMap - The text position map
 * @param {number} charIndex - Index in the full concatenated text
 * @returns {{node: Node, localOffset: number}|null} - Node and offset, or null
 */
function findNodeAtIndex(textMap, charIndex) {
    for (const entry of textMap) {
        if (charIndex >= entry.startIndex && charIndex < entry.endIndex) {
            return {
                node: entry.node,
                localOffset: charIndex - entry.startIndex,
                entry
            };
        }
    }
    return null;
}

/**
 * Surgically remove a character from a text node at a specific position.
 * Mutates the node's textContent directly.
 * 
 * @param {Node} node - The <w:t> XML node
 * @param {number} localOffset - Position within the node's text
 */
function removeCharAtOffset(node, localOffset) {
    const text = node.textContent || '';
    if (localOffset >= 0 && localOffset < text.length) {
        const newText = text.slice(0, localOffset) + text.slice(localOffset + 1);
        node.textContent = newText;
    }
}

/**
 * Repair DOCX XML using the Text Mapping strategy.
 * 
 * 1. Parse XML into DOM
 * 2. Build text map of all <w:t> nodes
 * 3. Find quoted variables in concatenated text
 * 4. Surgically delete quote characters from their specific nodes
 * 5. Serialize DOM back to XML
 * 
 * @param {string} xmlContent - Raw XML content
 * @returns {{repairedXml: string, variables: string[]}} - Repaired XML and variables
 */
function repairXmlContent(xmlContent) {
    // Step 1: Parse XML into DOM
    const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
    
    // Step 2: Build the text map
    const { fullText, textMap } = buildTextMap(doc);
    
    // Step 3: Find quoted variables
    const matches = findQuotedVariablesWithPositions(fullText);
    
    if (matches.length === 0) {
        return { repairedXml: xmlContent, variables: [] };
    }
    
    console.log(`[Text Map] Found ${matches.length} quoted variables: ${matches.map(m => m.varName).join(', ')}`);
    
    // Step 4: Surgically remove quotes
    // IMPORTANT: Process in reverse order so indices remain valid!
    // Sort matches by closeQuoteIndex descending, then openQuoteIndex descending
    const sortedMatches = [...matches].sort((a, b) => b.closeQuoteIndex - a.closeQuoteIndex);
    
    const variables = new Set();
    
    for (const match of sortedMatches) {
        variables.add(match.varName);
        
        // Remove closing quote first (higher index)
        const closeNode = findNodeAtIndex(textMap, match.closeQuoteIndex);
        if (closeNode) {
            console.log(`[Text Map] Removing closing quote from node at index ${match.closeQuoteIndex} (local offset ${closeNode.localOffset})`);
            removeCharAtOffset(closeNode.node, closeNode.localOffset);
            // Update the text map entry
            closeNode.entry.text = closeNode.node.textContent || '';
        }
        
        // Remove opening quote (lower index - still valid since we haven't touched it yet)
        const openNode = findNodeAtIndex(textMap, match.openQuoteIndex);
        if (openNode) {
            console.log(`[Text Map] Removing opening quote from node at index ${match.openQuoteIndex} (local offset ${openNode.localOffset})`);
            removeCharAtOffset(openNode.node, openNode.localOffset);
            // Update the text map entry
            openNode.entry.text = openNode.node.textContent || '';
        }
    }
    
    // Step 5: Serialize DOM back to XML
    const serializer = new XMLSerializer();
    const repairedXml = serializer.serializeToString(doc);
    
    return {
        repairedXml,
        variables: Array.from(variables).sort()
    };
}

/**
 * Scan DOCX XML for quoted variables using text mapping.
 * This extracts all text, concatenates it, and finds patterns.
 * 
 * @param {string} xmlContent - Raw XML content
 * @returns {string[]} - Array of variable names found
 */
function scanXmlForVariables(xmlContent) {
    const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
    const { fullText } = buildTextMap(doc);
    const matches = findQuotedVariablesWithPositions(fullText);
    
    // Extract unique variable names
    const variables = new Set();
    matches.forEach(m => variables.add(m.varName));
    
    return Array.from(variables).sort();
}

/**
 * Apply text-mapping repair to all text-containing files in a DOCX zip
 * 
 * @param {PizZip} zip - The PizZip instance containing the DOCX
 * @returns {PizZip} - Modified PizZip with repaired XML
 */
function repairDocxZip(zip) {
    const xmlFiles = [
        'word/document.xml',
        'word/header1.xml',
        'word/header2.xml',
        'word/header3.xml',
        'word/footer1.xml',
        'word/footer2.xml',
        'word/footer3.xml'
    ];
    
    let totalVarsFound = 0;
    let allVars = [];
    
    for (const fileName of xmlFiles) {
        const file = zip.file(fileName);
        if (!file) continue;
        
        const originalContent = file.asText();
        const { repairedXml, variables } = repairXmlContent(originalContent);
        
        totalVarsFound += variables.length;
        allVars = allVars.concat(variables);
        
        // Only update if changes were made
        if (repairedXml !== originalContent) {
            console.log(`[Text Map] Processed ${fileName} (${variables.length} vars: ${variables.join(', ')})`);
            zip.file(fileName, repairedXml);
        }
    }
    
    console.log(`[Text Map] Total variables processed: ${totalVarsFound}`);
    if (allVars.length > 0) {
        console.log(`[Text Map] All variables: ${[...new Set(allVars)].join(', ')}`);
    }
    return zip;
}

/**
 * Scan DOCX for variables using text-mapping extraction.
 * 
 * ONLY returns variables that are enclosed in quotes.
 * Unquoted brackets like [PROPOSED] are intentionally ignored.
 * 
 * @param {Buffer} docxBuffer - The DOCX file content as a buffer
 * @returns {string[]} - Array of unique variable names (without brackets)
 */
function scanDocxForVariables(docxBuffer) {
    const zip = new PizZip(docxBuffer);
    const allVariables = new Set();
    
    const xmlFiles = [
        'word/document.xml',
        'word/header1.xml',
        'word/header2.xml',
        'word/header3.xml',
        'word/footer1.xml',
        'word/footer2.xml',
        'word/footer3.xml'
    ];
    
    console.log(`[Scan] Starting text-mapping DOCX variable scan...`);
    
    for (const fileName of xmlFiles) {
        const file = zip.file(fileName);
        if (!file) continue;
        
        const xmlContent = file.asText();
        
        // Use text-mapping extraction to find quoted variables
        const variables = scanXmlForVariables(xmlContent);
        
        if (variables.length > 0) {
            console.log(`[Scan] ${fileName}: found ${variables.length} vars: ${variables.join(', ')}`);
        }
        
        // Add all found variables to our set
        variables.forEach(v => allVariables.add(v));
    }
    
    const result = Array.from(allVariables).sort();
    console.log(`[Scan] FINAL RESULT: ${result.length} quoted variables detected: ${result.join(', ')}`);
    return result;
}

app.get('/api/scan-docx/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        // Security: prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        const filePath = path.join(__dirname, 'templates', filename);
        const content = await fs.readFile(filePath);
        
        // Use strict scanning - ONLY finds quoted variables
        const uniqueVars = scanDocxForVariables(content);
        
        console.log(`Scanned ${filename}: found ${uniqueVars.length} quoted variables`);
        
        res.json({ 
            success: true, 
            variables: uniqueVars,
            filename: filename
        });
    } catch (error) {
        console.error('Error scanning DOCX:', error);
        res.status(500).json({ error: 'Failed to scan DOCX: ' + error.message });
    }
});

/**
 * Normalize JSON keys for Docxtemplater
 * Accepts both "[VAR_NAME]" and "VAR_NAME" formats from JSON
 * Maps to "VAR_NAME" format that Docxtemplater expects
 * 
 * @param {Object} data - The input JSON data
 * @returns {Object} - Normalized data object with keys in "VAR_NAME" format (no brackets)
 */
function normalizeDocxData(data) {
    const normalized = {};
    
    for (const [key, value] of Object.entries(data)) {
        // Extract variable name without brackets
        let varName;
        if (key.startsWith('[') && key.endsWith(']')) {
            varName = key.slice(1, -1);
        } else {
            varName = key;
        }
        
        // Store in normalized format (without brackets)
        normalized[varName] = value;
    }
    
    return normalized;
}

// Fill DOCX with provided JSON data
app.post('/api/fill-docx', async (req, res) => {
    try {
        const { templateName, jsonData } = req.body;
        
        if (!templateName || !jsonData) {
            return res.status(400).json({ error: 'Template name and JSON data are required' });
        }
        
        // Security: prevent path traversal
        if (templateName.includes('..') || templateName.includes('/') || templateName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        // Parse JSON if it's a string
        let data;
        try {
            data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON format' });
        }

        // === INSERTED LOGIC START ===
        // 1. Sanitize all values
        data = sanitizeAllValues(data);

        // 2. Process computed variables (e.g. VAR_ATTY_EMAIL, VAR_CITY_STATE_ZIP)
        // This generates the combined fields needed for the template
        data = await processDynamicVariables(data);
        // === INSERTED LOGIC END ===

        // Normalize keys: support both "[VAR]" and "VAR" formats
        const normalizedData = normalizeDocxData(data);
        
        const filePath = path.join(__dirname, 'templates', templateName);
        const content = await fs.readFile(filePath);
        
        // Load the docx file using PizZip
        let zip = new PizZip(content);
        
        // ============================================================
        // CRUCIAL PRE-PROCESSING STEP
        // ============================================================
        // Run the STRICT repair: strips quotes from quoted variables ONLY
        // - "[VAR]" becomes [VAR] (ready for Docxtemplater)
        // - [PROPOSED] stays [PROPOSED] (no quotes, untouched)
        zip = repairDocxZip(zip);
        
        // Initialize Docxtemplater with SQUARE BRACKET delimiters
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            // Use square bracket delimiters to match [VAR_NAME] format
            delimiters: { start: '[', end: ']' },
            // nullGetter: Return the raw tag if variable is missing
            // This preserves unquoted brackets like [PROPOSED] and [X]
            // Since [PROPOSED] has no data, it will be returned as "[PROPOSED]"
            nullGetter: function(part, scopeManager) {
                if (!part.module) {
                    // Return the original tag wrapped in brackets
                    return '[' + part.value + ']';
                }
                if (part.module === 'loop') {
                    return [];
                }
                return '[' + part.value + ']';
            }
        });
        
        // Render the document with normalized data
        doc.render(normalizedData);
        
        // Generate the filled document as a buffer
        const filledBuffer = doc.getZip().generate({
            type: 'nodebuffer',
            compression: 'DEFLATE'
        });
        
        // Return as base64 for preview/download
        const base64Doc = filledBuffer.toString('base64');
        
        // Count how many variables were actually filled
        const filledCount = Object.keys(data).filter(k => data[k] && data[k] !== '').length;
        
        console.log(`Filled DOCX template: ${templateName} (${filledCount} variables with values)`);
        
        res.json({
            success: true,
            docxData: base64Doc,
            filename: templateName.replace('.docx', '_filled.docx'),
            filledCount: filledCount
        });
    } catch (error) {
        console.error('Error filling DOCX:', error);
        
        // Handle docxtemplater-specific errors
        if (error.properties && error.properties.errors) {
            const errorMessages = error.properties.errors.map(e => e.message).join(', ');
            return res.status(400).json({ error: 'Template error: ' + errorMessages });
        }
        
        res.status(500).json({ error: 'Failed to fill DOCX: ' + error.message });
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
        
        // Validate PDF file (check for PDF magic bytes)
        if (existingPdfBytes.length < 4 || existingPdfBytes[0] !== 0x25 || existingPdfBytes[1] !== 0x50 || existingPdfBytes[2] !== 0x44 || existingPdfBytes[3] !== 0x46) {
            return res.status(400).json({ error: 'Invalid PDF file: File does not appear to be a valid PDF' });
        }
        
        // Load the PDF with error handling
        let pdfDoc;
        try {
            // Try loading normally first
            pdfDoc = await PDFDocument.load(existingPdfBytes);
        } catch (loadError) {
            // If normal load fails, try with ignoreEncryption option
            try {
                console.log('Normal load failed, trying with ignoreEncryption option...');
                pdfDoc = await PDFDocument.load(existingPdfBytes, { ignoreEncryption: true });
            } catch (retryError) {
                console.error('PDF load error details:', {
                    error: loadError.message,
                    retryError: retryError.message,
                    stack: loadError.stack,
                    templateName: templateName,
                    fileSize: existingPdfBytes.length,
                    firstBytes: Array.from(existingPdfBytes.slice(0, 20))
                });
                return res.status(400).json({ 
                    error: `Failed to load PDF: ${loadError.message}. The PDF file may be corrupted or invalid. Please verify the file is a valid PDF.` 
                });
            }
        }
        
        // Get the form from the PDF
        let form;
        let fields;
        try {
            form = pdfDoc.getForm();
            fields = form.getFields();
        } catch (formError) {
            console.error('PDF form error:', formError);
            return res.status(400).json({ 
                error: `Failed to access PDF form: ${formError.message}. The PDF may not contain form fields.` 
            });
        }
        
        // Field info for debugging / returned to client
        const fieldInfo = fields.map(field => ({
            name: field.getName(),
            type: field.constructor ? field.constructor.name : typeof field
        }));

        // Strip "Rich Text" flag from fields to prevent pdf-lib crash on .save()
        // Check both the field's own dictionary and each widget's dictionary
        const { PDFName, PDFNumber } = require('pdf-lib');
        fields.forEach(field => {
            try {
                // First, check the field's own acroField dictionary
                const acroField = field.acroField;
                if (acroField && acroField.dict) {
                    const fieldDict = acroField.dict;
                    if (fieldDict.has(PDFName.of('Ff'))) {
                        const flags = fieldDict.get(PDFName.of('Ff')).asNumber();
                        // Bitwise remove the 26th bit (0x2000000) - Rich Text flag
                        fieldDict.set(PDFName.of('Ff'), PDFNumber.of(flags & ~0x2000000));
                    }
                }
                
                // Also check each widget's dictionary
                const widgets = field.getWidgets();
                widgets.forEach(widget => {
                    const dict = widget.dict;
                    // PDF spec: Bit 26 of the Ff (Field Flags) entry is for Rich Text
                    // We want to ensure it is off so pdf-lib doesn't crash on .save()
                    if (dict.has(PDFName.of('Ff'))) {
                        const flags = dict.get(PDFName.of('Ff')).asNumber();
                        // Bitwise remove the 26th bit (0x2000000)
                        dict.set(PDFName.of('Ff'), PDFNumber.of(flags & ~0x2000000));
                    }
                });
            } catch (e) {
                // Skip fields that don't support this
                console.log(`Could not strip Rich Text flag from field: ${e.message}`);
            }
        });

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
        let pdfBytes;
        try {
            pdfBytes = await pdfDoc.save();
        } catch (saveError) {
            console.error('PDF save error details:', {
                error: saveError.message,
                stack: saveError.stack,
                templateName: templateName
            });
            
            // Check if this is the specific corruption error
            if (saveError.message.includes('Expected instance of PDFDict') || 
                saveError.message.includes('but got instance of undefined')) {
                return res.status(400).json({ 
                    error: `PDF file appears to be corrupted or has invalid internal references. The PDF needs to be repaired before it can be filled. ` +
                           `Try opening and re-saving the PDF in Adobe Acrobat or another PDF editor, or use a PDF repair tool. ` +
                           `Original error: ${saveError.message}`
                });
            }
            
            return res.status(500).json({ 
                error: `Failed to save PDF: ${saveError.message}` 
            });
        }
        
        // Store editable version in memory
        currentFilledPDF = Buffer.from(pdfBytes);
        currentPDFName = templateName.replace('.pdf', '_filled.pdf');
        
        // Create flattened court-ready version
        let flattenedPdfBytes;
        try {
            form.flatten();
            flattenedPdfBytes = await pdfDoc.save();
            currentCourtReadyPDF = Buffer.from(flattenedPdfBytes);
        } catch (flattenError) {
            console.error('PDF flatten error:', flattenError);
            // If flatten fails, just use the non-flattened version
            currentCourtReadyPDF = Buffer.from(pdfBytes);
        }

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
        
        // Validate PDF file (check for PDF magic bytes)
        if (existingPdfBytes.length < 4 || existingPdfBytes[0] !== 0x25 || existingPdfBytes[1] !== 0x50 || existingPdfBytes[2] !== 0x44 || existingPdfBytes[3] !== 0x46) {
            return res.status(400).json({ error: 'Invalid PDF file: File does not appear to be a valid PDF' });
        }
        
        // Load the PDF with error handling
        let pdfDoc;
        try {
            // Try loading normally first
            pdfDoc = await PDFDocument.load(existingPdfBytes);
        } catch (loadError) {
            // If normal load fails, try with ignoreEncryption option
            try {
                console.log('Normal load failed, trying with ignoreEncryption option...');
                pdfDoc = await PDFDocument.load(existingPdfBytes, { ignoreEncryption: true });
            } catch (retryError) {
                console.error('PDF load error details:', {
                    error: loadError.message,
                    retryError: retryError.message,
                    stack: loadError.stack,
                    templateName: templateName,
                    fileSize: existingPdfBytes.length,
                    firstBytes: Array.from(existingPdfBytes.slice(0, 20))
                });
                return res.status(400).json({ 
                    error: `Failed to load PDF: ${loadError.message}. The PDF file may be corrupted or invalid. Please verify the file is a valid PDF.` 
                });
            }
        }
        
        // Get the form from the PDF
        let form;
        let fields;
        try {
            form = pdfDoc.getForm();
            fields = form.getFields();
        } catch (formError) {
            console.error('PDF form error:', formError);
            return res.status(400).json({ 
                error: `Failed to access PDF form: ${formError.message}. The PDF may not contain form fields.` 
            });
        }
        
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
        let pdfBytes;
        try {
            pdfBytes = await pdfDoc.save();
        } catch (saveError) {
            console.error('PDF save error details:', {
                error: saveError.message,
                stack: saveError.stack,
                templateName: templateName
            });
            
            // Check if this is the specific corruption error
            if (saveError.message.includes('Expected instance of PDFDict') || 
                saveError.message.includes('but got instance of undefined')) {
                return res.status(400).json({ 
                    error: `PDF file appears to be corrupted or has invalid internal references. The PDF needs to be repaired before it can be filled. ` +
                           `Try opening and re-saving the PDF in Adobe Acrobat or another PDF editor, or use a PDF repair tool. ` +
                           `Original error: ${saveError.message}`
                });
            }
            
            return res.status(500).json({ 
                error: `Failed to save PDF: ${saveError.message}` 
            });
        }
        
        // Store editable version in memory
        currentFilledPDF = Buffer.from(pdfBytes);
        currentPDFName = templateName.replace('.pdf', '_filled.pdf');
        
        // Create flattened court-ready version
        let flattenedPdfBytes;
        try {
            form.flatten();
            flattenedPdfBytes = await pdfDoc.save();
            currentCourtReadyPDF = Buffer.from(flattenedPdfBytes);
        } catch (flattenError) {
            console.error('PDF flatten error:', flattenError);
            // If flatten fails, just use the non-flattened version
            currentCourtReadyPDF = Buffer.from(pdfBytes);
        }

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

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown handling for Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[Server] Received SIGINT (Ctrl+C). Shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Closed all connections. Exiting.');
        process.exit(0);
    });
    
    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});

process.on('SIGTERM', () => {
    console.log('\n[Server] Received SIGTERM. Shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Closed all connections. Exiting.');
        process.exit(0);
    });
});
