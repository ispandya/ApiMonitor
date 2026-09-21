CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS monitors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'GET',
  expected_status   INT NOT NULL DEFAULT 200,
  interval_seconds  INT NOT NULL DEFAULT 60,
  timeout_ms        INT NOT NULL DEFAULT 10000,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  current_status    TEXT NOT NULL DEFAULT 'unknown',
  webhook_url       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checks (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  monitor_id    UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  status_code   INT,
  latency_ms    INT,
  error_message TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, checked_at)
);

CREATE INDEX IF NOT EXISTS idx_checks_monitor_time
  ON checks (monitor_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id      UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  cause           TEXT,
  notified        BOOLEAN NOT NULL DEFAULT false
);