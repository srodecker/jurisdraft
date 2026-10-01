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

## Case Documents (/kinecta → Documents)

Upload files to a case: pick a case from the dropdown (or add a new one), then drag files onto the page or click the drop zone. Click **Edit** to rename or remove uploaded files. Up to 50 MB per file.

- **Supabase**: run `supabase-schema.sql` to create the `case_documents` table. Files go to the private Storage bucket `case-documents` (created automatically). Requires `SUPABASE_SERVICE_KEY`. Browsers upload directly to Storage via signed URLs, so the serverless request size limit does not apply.
- **No Supabase**: files are stored under `case-documents/` on local disk.

Deleting a case deletes its documents.

## Technical Details

- **Backend**: Node.js with Express
- **PDF Processing**: pdf-lib (preserves form fields without locking)
- **Frontend**: Vanilla HTML/CSS/JavaScript

