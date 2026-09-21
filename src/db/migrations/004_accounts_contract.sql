-- The "contract" half: run this only AFTER the code that uses account_id is deployed.
--
-- First a catch-up backfill. Between migration 003 and the deploy, the old code may have
-- created monitors that have an api_key_id but no account_id yet. Copy those across, so
-- dropping the old column cannot lose anyone's ownership.
UPDATE monitors m
   SET account_id = k.account_id
  FROM api_keys k
 WHERE m.api_key_id = k.id
   AND m.account_id IS NULL;

-- Dropping the column also drops its foreign key and its index (idx_monitors_api_key).
ALTER TABLE monitors DROP COLUMN api_key_id;
