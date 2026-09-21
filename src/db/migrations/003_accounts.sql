-- Accounts own monitors; API keys belong to an account. Rotating a key no longer loses data,
-- because the monitors were never tied to the key in the first place.
--
-- This is the "expand" half of expand / deploy / contract: it only ADDS things and copies
-- data, so the code that is still running (which uses monitors.api_key_id) keeps working.
-- Migration 004 removes the old column once the new code is deployed.

CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_keys ADD COLUMN account_id UUID REFERENCES accounts(id);
ALTER TABLE monitors ADD COLUMN account_id UUID REFERENCES accounts(id);

-- Backfill 1: every existing key gets an account of its own, named after the key. The ids are
-- generated once, in "mapping", so the same account id is used for both the new account row
-- and the key that points at it.
WITH mapping AS (
  SELECT id AS key_id, gen_random_uuid() AS account_id, name FROM api_keys
), created AS (
  INSERT INTO accounts (id, name) SELECT account_id, name FROM mapping RETURNING id
)
UPDATE api_keys k SET account_id = m.account_id FROM mapping m WHERE k.id = m.key_id;

-- Backfill 2: a monitor belongs to whichever account its key now belongs to. Monitors that
-- never had an owner (api_key_id IS NULL) stay ownerless.
UPDATE monitors m SET account_id = k.account_id FROM api_keys k WHERE m.api_key_id = k.id;

-- Every key must now have an account, and new keys are required to name one.
ALTER TABLE api_keys ALTER COLUMN account_id SET NOT NULL;

-- Foreign keys are not indexed automatically, and both are looked up constantly.
CREATE INDEX idx_api_keys_account ON api_keys (account_id);
CREATE INDEX idx_monitors_account ON monitors (account_id);
