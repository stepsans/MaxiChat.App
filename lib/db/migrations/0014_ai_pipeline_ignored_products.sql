-- AI Pipeline: products the owner dismissed from the "Peluang Produk Baru"
-- (new-product demand) section of a pipeline's analytics. A dismissed
-- product_interest never reappears in that section for the pipeline, even when
-- a later customer asks for it again. Scoped per (pipeline, product_interest).
-- Apply: psql "$DATABASE_URL" -f lib/db/migrations/0014_ai_pipeline_ignored_products.sql
CREATE TABLE IF NOT EXISTS ai_pipeline_ignored_products (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  product_interest TEXT NOT NULL,
  ignored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pipeline_id, product_interest)
);

CREATE INDEX IF NOT EXISTS idx_ai_pipeline_ignored_products_pipeline
  ON ai_pipeline_ignored_products(pipeline_id);

CREATE INDEX IF NOT EXISTS idx_ai_pipeline_ignored_products_owner
  ON ai_pipeline_ignored_products(owner_user_id);
