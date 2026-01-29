const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function getTodayDateLA() {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "long",
        day: "numeric",
        year: "numeric"
    }).format(new Date());
}

// Retry helper function with exponential backoff
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(300000) // 5 min timeout
            });
            
            // If 503 or 429, retry with exponential backoff
            if (response.status === 503 || response.status === 429) {
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // Max 30s
                    console.log(`API returned ${response.status}, retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Retry
                }
            }
            
            return response; // Success or non-retryable error
        } catch (err) {
            // Handle timeout/abort errors
            if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
                    console.log(`Request timeout, retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }
            
            // If this is the last attempt, throw the error
            if (attempt === maxRetries) throw err;
            
            // Otherwise retry with exponential backoff
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// POST /api/extract
router.post('/extract', upload.array('files'), async (req, res) => {
    try {
        const promptPath = path.join(__dirname, '..', 'Prompts', 'Extraction_Prompt.txt');
        let promptTemplate = '';
        try {
            promptTemplate = await fs.readFile(promptPath, 'utf8');
        } catch (err) {
            console.error('Failed to read prompt file:', err.message);
            return res.status(500).json({ error: 'Failed to read prompt file' });
        }

        const files = req.files || [];
        let filesInfoText = '';
        const fileArtifacts = [];
        for (const f of files) {
            const b64 = f.buffer.toString('base64');
            filesInfoText += `\n---\nFilename: ${f.originalname}\nSize: ${f.size} bytes\nBase64Len: ${b64.length}\n`;
            fileArtifacts.push({ filename: f.originalname, mimeType: f.mimetype, base64: b64 });
        }

        const modelInput = `${promptTemplate}\n\nAttached files metadata:${filesInfoText}\n\nRespond with a single JSON object as requested in the prompt.`;

        const apiKey = process.env.GOOGLE_API_KEY;
        if (apiKey) {
            try {
                // Use gemini-2.0-flash-exp which is the latest experimental model
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;

                const todayDateLA = getTodayDateLA();
                const parts = [];
                parts.push({ text: promptTemplate + `\n\nCURRENT_DATE_CONTEXT: ${todayDateLA}\n\nRespond with a single JSON object.` });

                for (const f of files) {
                    parts.push({
                        inline_data: {
                            mime_type: f.mimetype,
                            data: f.buffer.toString('base64')
                        }
                    });
                }

                const fetchBody = {
                    contents: [{ parts: parts }],
                    generationConfig: {
                        temperature: 0.0,
                        response_mime_type: "application/json"
                    }
                };

                // Use retry logic for the API call
                const response = await fetchWithRetry(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fetchBody)
                });

                // Check response status before parsing
                if (!response.ok) {
                    let errorText = '';
                    let errorJson = null;
                    try {
                        errorJson = await response.json();
                        errorText = JSON.stringify(errorJson);
                    } catch (e) {
                        errorText = await response.text();
                    }
                    
                    // Handle specific error codes
                    if (response.status === 503) {
                        console.error('Gemini API Service Unavailable (503):', errorText);
                        return res.status(503).json({ 
                            error: 'The AI service is temporarily unavailable. This can happen with complex documents or during high traffic. Please try again in a few moments.',
                            details: errorJson || errorText,
                            retryable: true
                        });
                    } else if (response.status === 429) {
                        console.error('Gemini API Rate Limited (429):', errorText);
                        return res.status(429).json({ 
                            error: 'Rate limit exceeded. Please wait a moment and try again.',
                            details: errorJson || errorText,
                            retryable: true
                        });
                    } else {
                        console.error(`Gemini API Error (${response.status}):`, errorText);
                        return res.status(response.status).json({ 
                            error: `API error: ${response.statusText}`,
                            details: errorJson || errorText
                        });
                    }
                }

                const json = await response.json();

                let generated = null;
                if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
                    generated = json.candidates[0].content.parts.map(p => p.text).join('');
                    
                    // --- Post-processing Overrides ---
                    try {
                        // Attempt to parse the generated JSON to apply strict overrides
                        let cleanJsonStr = generated;
                        // Strip markdown code blocks if present
                        const match = generated.match(/```json\s*([\s\S]*?)\s*```/) || generated.match(/```\s*([\s\S]*?)\s*```/);
                        if (match) cleanJsonStr = match[1];

                        const parsed = JSON.parse(cleanJsonStr);
                        
                        // 1. Force DATE_SIGNED to today's date in LA time
                        parsed["[DATE_SIGNED]"] = todayDateLA;
                        // Also handle unbracketed key just in case
                        if (parsed["DATE_SIGNED"] !== undefined) parsed["DATE_SIGNED"] = todayDateLA;
                        
                        // 2. Clean PLAINTIFF_NAME (remove trailing comma)
                        let pName = parsed["[PLAINTIFF_NAME]"] || parsed["PLAINTIFF_NAME"] || "";
                        if (pName && typeof pName === 'string') {
                            pName = pName.trim().replace(/,\s*$/, ''); // Remove trailing comma
                            if (parsed["[PLAINTIFF_NAME]"] !== undefined) parsed["[PLAINTIFF_NAME]"] = pName;
                            if (parsed["PLAINTIFF_NAME"] !== undefined) parsed["PLAINTIFF_NAME"] = pName;
                            
                            // Also update mirror field if it exists
                            if (parsed["[PLAINTIFF_NAME_P2]"] !== undefined) parsed["[PLAINTIFF_NAME_P2]"] = pName;
                            if (parsed["PLAINTIFF_NAME_P2"] !== undefined) parsed["PLAINTIFF_NAME_P2"] = pName;
                        }

                        // Sanity Check Logging
                        console.log(`[Sanity Check] DATE_SIGNED: "${parsed["[DATE_SIGNED]"]}" (Expected: "${todayDateLA}")`);

                        // Re-serialize to string so the client receives the modified version
                        generated = JSON.stringify(parsed, null, 2);
                    } catch (parseErr) {
                        console.warn('Failed to parse generated JSON for post-processing overrides:', parseErr.message);
                        // Fallback: Try regex replacement on the raw string to ensure date is updated
                        // Handle both bracketed and unbracketed versions
                        generated = generated.replace(/"\[?DATE_SIGNED\]?"\s*:\s*"[^"]*"/g, `"[DATE_SIGNED]": "${todayDateLA}"`);
                    }
                    // ---------------------------------

                } else if (json.error) {
                    // Pass through the API error
                    generated = JSON.stringify(json); 
                } else {
                    generated = JSON.stringify(json);
                }

                return res.json({ success: true, generated, raw: json });
            } catch (err) {
                console.error('Error calling generative API:', err);
                
                // Handle timeout errors
                if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                    return res.status(504).json({ 
                        error: 'Request timed out. The document may be too complex or large. Try breaking it into smaller parts or try again later.',
                        retryable: true
                    });
                }
                
                // Handle network errors
                if (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('ECONNREFUSED')) {
                    return res.status(503).json({ 
                        error: 'Network error connecting to AI service. Please check your connection and try again.',
                        details: err.message,
                        retryable: true
                    });
                }
                
                return res.status(500).json({ error: 'Generative API call failed', details: err.message });
            }
        }

        // No API key configured — return metadata and prompt preview
        return res.json({
            success: false,
            note: 'No GOOGLE_API_KEY configured; returning file metadata and prompt. Set GOOGLE_API_KEY to call Gemini.',
            promptPreview: modelInput.substring(0, 4000),
            files: fileArtifacts
        });
    } catch (error) {
        console.error('Error in /api/extract:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
