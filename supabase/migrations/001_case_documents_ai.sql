-- AI reading columns on case_documents (safe to re-run).
-- The reading queue keeps its state in the analysis JSONB column; no other tables are needed.
ALTER TABLE case_documents
    ADD COLUMN IF NOT EXISTS analysis JSONB,
    ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gemini_file_uri TEXT,
    ADD COLUMN IF NOT EXISTS gemini_file_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS full_text TEXT,
    ADD COLUMN IF NOT EXISTS text_chars INTEGER;

-- Make the Supabase API see the new columns immediately
NOTIFY pgrst, 'reload schema';
