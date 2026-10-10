# JurisDraft

PDF form filler web application. Easily fill PDF forms with JSON data.

## Features

- 📄 Select PDF templates from the templates folder
- 📝 Fill forms by pasting JSON data with field values
- 👀 Preview filled PDFs before downloading
- 🔄 Submit additional JSON to update the same PDF
- ⬇️ Download filled PDFs
- 🔓 PDFs remain editable (not locked/flattened)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Add your PDF forms to the `templates` folder

3. Start the server:
```bash
npm start
```

4. Open your browser to http://localhost:3000

## Usage

1. **Select a PDF Template**: Choose from available PDFs in the templates folder
2. **Enter JSON Data**: Paste JSON with field names matching PDF form fields
3. **Click "Go"**: Fill the PDF and preview it
4. **Submit Additional JSON**: Update the same PDF with more data (optional)
5. **Download**: Save the filled PDF to your computer

## JSON Format

Your JSON should contain key-value pairs where keys match the PDF form field names:

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "address": "123 Main St"
}
```

To see available field names for a PDF, open the browser console after clicking "Go" - it will list all form fields.

## Example

A sample form (`sample-form.pdf`) is included in the templates folder with these fields:
- firstName
- lastName  
- email
- phone
- address
- city
- state
- zipCode
- country
- comments

## Kinecta Case Manager (/kinecta)

A case manager for consumer-loan collections, built from each case's own documents.

- **Today**: overdue and upcoming deadlines across all cases, upcoming hearings, a pipeline by stage, recent documents, and a quick-ask box for the Assistant.
- **Cases**: create a case with just the debtor name, then drop its documents in. Everything else comes from the documents.
- **Case page**:
  - Overview: AI summary, parties and court, service, default and judgment dates, deadlines, prepared forms
  - Documents: drag and drop anywhere on the page; rename or remove
  - Timeline
  - Forms
  - Ask AI
- **Edit facts**: corrections are kept when the case is refreshed from documents.
- **Deadlines** are computed from California rules:
  - CRC 3.110(b): serve within 60 days
  - CCP 412.20 / 415.20: 30 days to respond (+10 days after substituted service)
  - CRC 3.110(g): request default within 10 days
  - CRC 3.110(h): judgment within 45 days
  - CCP 683.020: renew the judgment before 10 years
  
  Hearings and custom reminders are included.
- **Forms** are filled from the case and the signed-in user's firm profile, stored on the case, and listed with the values used and any blank key fields:
  - SUM-100
  - CM-010
  - LACIV 109
  - CIV-100 (request for default, request for court judgment)
  - POS by mail
  - EJ-001
  - CIV-110
- **Assistant**:
  - global, or scoped to one case
  - answers from the stored text of every document
  - can update case facts, add timeline entries and reminders, list what needs attention, and prepare forms (e.g. "prepare the request for default for Acevedo with costs of $435")

### Documents
- **Supabase**: run `supabase-schema.sql` once. Uploaded files go to the private Storage bucket `case-documents`, which is created automatically, and generated forms go under `generated/` in the same bucket. Requires `SUPABASE_SERVICE_KEY`. Browsers upload directly to Storage via signed URLs, so the serverless request size limit doesn't apply. Up to 50 MB per file.
- **No Supabase**: files are stored under `case-documents/` on local disk.

**AI reading (once per document):** each upload is turned into plain text and stored with the document (`case_documents.full_text`):
- Digital PDFs: text layer.
- Scanned PDFs, PDFs with filled form fields, and images: AI transcription (Gemini, 20 pages per request).
- .docx: text.
- .eml / .msg: headers, body, and the text of PDF/Word/email attachments.

A summary, key facts, dates and events are then generated from that text.

**Refresh from documents** rebuilds the case's facts, dates, timeline, hearings and form data from all of its documents. Kept as they are: your fact corrections, reminders, prepared forms and chat history. Requires `GOOGLE_API_KEY`.

API:
- `GET /api/dashboard/today`
- `GET|POST /api/cases`
- `GET /api/cases/:id`
- `PATCH /api/cases/:id/facts`
- `POST|PATCH|DELETE /api/cases/:id/deadlines`
- `GET /api/forms`
- `POST /api/cases/:id/forms`
- `GET /api/cases/:id/forms/:formId/download`
- `POST /api/assistant`
- `GET|DELETE /api/assistant/history`

## Technical Details

- **Backend**: Node.js with Express
- **PDF Processing**: pdf-lib (preserves form fields without locking)
- **Frontend**: Vanilla HTML/CSS/JavaScript

