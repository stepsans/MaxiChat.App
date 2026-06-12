-- ACR: opt-in toggle to include the tenant owner (super_admin) as an
-- evaluated agent. Default OFF — production tenants evaluate supervisors +
-- agents only; owners enable it for self-service CS or testing.
ALTER TABLE acr_configs
  ADD COLUMN IF NOT EXISTS include_owner_in_evaluation BOOLEAN NOT NULL DEFAULT false;
