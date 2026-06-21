-- AI Pipeline: store the CUSTOMER's detected language register/tone once at
-- analysis time, so every follow-up (FU1..FU3) mirrors a consistent style
-- instead of re-inferring it live from the last 10 messages each time.
-- Apply: psql "$DATABASE_URL" -f lib/db/migrations/0012_ai_pipeline_customer_tone.sql
ALTER TABLE ai_pipeline_analyses
  ADD COLUMN IF NOT EXISTS customer_tone text;
