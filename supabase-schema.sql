-- Kinecta Case Manager — Supabase Schema
-- Run this in your Supabase SQL Editor (https://app.supabase.com → SQL Editor)

-- Matters table: stores each case as a JSONB document
CREATE TABLE IF NOT EXISTS matters (
    id UUID PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by debtor name and status
CREATE INDEX IF NOT EXISTS idx_matters_debtor ON matters ((data->>'debtorName'));
CREATE INDEX IF NOT EXISTS idx_matters_status ON matters ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_matters_updated ON matters (updated_at DESC);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_assigned ON notifications ((data->>'assignedTo'));
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

-- Global chat history
CREATE TABLE IF NOT EXISTS global_chat (
    id SERIAL PRIMARY KEY,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (but allow all access via service key)
ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_chat ENABLE ROW LEVEL SECURITY;

-- Policies: allow full access (this is an internal tool, not user-facing)
CREATE POLICY "Allow all access to matters" ON matters FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to notifications" ON notifications FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to global_chat" ON global_chat FOR ALL USING (true) WITH CHECK (true);
