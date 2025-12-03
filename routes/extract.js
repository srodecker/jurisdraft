const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/extract
router.post('/extract', upload.array('files'), async (req, res) => {
    try {
        const promptPath = path.join(__dirname, '..', 'Prompts', 'Ej-001_Extract.txt');
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
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;

                const parts = [];
                parts.push({ text: promptTemplate + "\n\nRespond with a single JSON object." });

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

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fetchBody)
                });

                const json = await response.json();

                let generated = null;
                if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
                    generated = json.candidates[0].content.parts.map(p => p.text).join('');
                } else if (json.error) {
                    // Pass through the API error
                    generated = JSON.stringify(json); 
                } else {
                    generated = JSON.stringify(json);
                }

                return res.json({ success: true, generated, raw: json });
            } catch (err) {
                console.error('Error calling generative API:', err);
                return res.status(500).json({ error: 'Generative API call failed', details: err.message });
            }
        }

        // No API key configured — return metadata and prompt preview
        return res.json({
            success: true,
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
