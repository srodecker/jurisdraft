-- Add the AI columns to case_documents (tables created before they existed),
-- then make PostgREST reload its schema cache so the API sees them.
ALTER TABLE case_documents
    ADD COLUMN IF NOT EXISTS analysis JSONB,
    ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gemini_file_uri TEXT,
    ADD COLUMN IF NOT EXISTS gemini_file_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS full_text TEXT,
    ADD COLUMN IF NOT EXISTS text_chars INTEGER;

NOTIFY pgrst, 'reload schema';
