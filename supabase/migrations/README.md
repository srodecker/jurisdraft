# Migrations

Apply in filename order. Each file is idempotent.

    for f in supabase/migrations/*.sql; do psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done

Or paste a file into the Supabase SQL Editor. The baseline matches `supabase-schema.sql`;
add schema changes as new timestamped files here, not by editing old ones.
