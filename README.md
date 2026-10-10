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

A case manager for consumer-loan collections in California courts, built from each case's own documents.

**Pages**

| Page | What it does |
|---|---|
| Today | Overdue and due-soon deadlines with one-click **Prepare**, hearings, cases needing review, pipeline, recent documents. |
| Cases | Search, filter by stage, sort. |
| Case | Next step, conflicts to resolve, facts (each with its source document and quote), deadlines, prepared forms. Tabs: Documents (preview plus "what the AI read"), Timeline, Forms, Notes. The AI case assistant stays open beside it. |
| Calendar | Month and agenda views. **Add to Outlook / Google** gives a private ICS link. |
| Client report | Every case's stage, key dates, amounts, status and next step. Optional "activity since" date. Print/PDF or Excel. |
| Assistant | Questions across all cases. It can update facts, add reminders and timeline entries, and prepare forms or whole packages. |
| Settings | Firm and attorneys (filled into every form) and system status. |

Press **Ctrl/⌘+K** anywhere to jump to a case or page, or to ask the assistant.

**How documents become a case**
1. **Upload.** Files go straight to the private Supabase bucket `case-documents` (up to 50 MB each).
2. **Reading.** A server-side queue (`lib/doc-pipeline.js`, `POST /api/jobs/tick`) reads each file once into plain text:
   - PDF text layer; AI transcription for scans; .docx; .msg/.eml including attachments.
   - It then extracts a summary, facts with evidence quotes, events and hearings.
   - Failures retry 3 times and are then shown with the reason and a Retry button.
   - The queue state lives in `case_documents.analysis`. Any open page drives it. Closing the tab only pauses it.
   - For reading with no page open, see `supabase/migrations/002_background_reading_cron.sql`.
3. **Merging facts** (`lib/fact-merge.js`). Case facts are merged from every reading by source credibility:
   - Filed court papers and proofs of service count for more than drafts and emails.
   - A draft never proves a filing.
   - Addresses and balances come from the newest document.
   - Where credible documents disagree, the case shows a conflict to resolve once.
4. **Summary.** One small AI call writes the summary, status, next step and form data.

   A failed document never blocks the case. Your corrections (Edit facts, resolved conflicts, form edits) always win.

**Deadlines.** Computed from California rules:
- CRC 3.110(b): serve within 60 days
- CCP 412.20 / 415.20: 30 days to respond, +10 days for substituted service
- CRC 3.110(g): request default within 10 days
- CRC 3.110(h): judgment within 45 days
- CCP 683.020: renew the judgment before 10 years

Hearings from the documents and your own reminders are added.

**Forms.** SUM-100, CM-010, LACIV 109, CIV-100 (request for default, and request for court judgment), POS by mail, EJ-001, CIV-110.
- Packages prepare a whole step in one go: new filing, request for default, default judgment, abstract.
- Each prepared form keeps the values it used. Edit them and **Regenerate**, or open the package as one combined PDF.
- Review every form before filing.

**Setup**
- Supabase:
  - Run `supabase-schema.sql` once, or `supabase/migrations/*.sql` for upgrades.
  - Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
  - Settings are stored as JSON in the same bucket (`settings/`), so no extra tables are needed.
- AI: `GOOGLE_API_KEY` (Gemini).
- Optional: `CRON_SECRET` lets a scheduler call `/api/jobs/tick`.
- Without Supabase, everything is stored on local disk (`matters/`, `case-documents/`, `settings/`). Set `JD_DATA_DIR` to put it elsewhere.

**Tests.** `npm test` runs:
- unit tests: fact merging, deadlines, form data
- an end-to-end run of the server against `test/mock-gemini.js`: upload → read → facts → conflicts → forms/packages → calendar/ICS → report/Excel → assistant

## Technical Details

- **Backend**: Node.js with Express
- **PDF Processing**: pdf-lib (preserves form fields without locking)
- **Frontend**: Vanilla HTML/CSS/JavaScript

