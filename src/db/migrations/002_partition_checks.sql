-- Turn "checks" into a table partitioned by day, so old data can be removed by dropping a
-- partition (instant) instead of deleting millions of rows (slow, and leaves bloat behind).
--
-- A table cannot be converted in place: rename it, create the partitioned replacement,
-- copy the rows across, drop the old table. All of it runs in ONE transaction, so either the
-- whole swap happens or none of it does. Note the rename briefly blocks writers to "checks";
-- on a large live table you would stage this (copy in batches, then swap).

ALTER TABLE checks RENAME TO checks_old;
ALTER TABLE checks_old RENAME CONSTRAINT checks_pkey TO checks_old_pkey;
ALTER INDEX idx_checks_monitor_time RENAME TO idx_checks_old_monitor_time;

CREATE TABLE checks (
  id             UUID NOT NULL DEFAULT gen_random_uuid(),
  monitor_id     UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,
  status_code    INT,
  latency_ms     INT,
  error_message  TEXT,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);

-- On a partitioned table this creates the matching index on every partition, present and future.
CREATE INDEX idx_checks_monitor_time ON checks (monitor_id, checked_at DESC);

-- Safety net: a row whose time matches no partition lands here instead of failing the insert.
-- The maintenance job keeps real partitions ahead of "now", so this should stay empty.
CREATE TABLE checks_default PARTITION OF checks DEFAULT;

-- One partition per UTC day, from the oldest existing row through a week ahead.
DO $$
DECLARE
  first_day date;
  day date;
BEGIN
  SELECT coalesce((min(checked_at) AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date)
    INTO first_day FROM checks_old;
  FOR day IN
    SELECT d::date FROM generate_series(first_day, (now() AT TIME ZONE 'UTC')::date + 7, interval '1 day') AS d
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS checks_%s PARTITION OF checks FOR VALUES FROM (%L) TO (%L)',
      to_char(day, 'YYYYMMDD'),
      (day::timestamp AT TIME ZONE 'UTC'),
      ((day + 1)::timestamp AT TIME ZONE 'UTC')
    );
  END LOOP;
END $$;

INSERT INTO checks (id, monitor_id, status, status_code, latency_ms, error_message, checked_at)
  SELECT id, monitor_id, status, status_code, latency_ms, error_message, checked_at FROM checks_old;

DROP TABLE checks_old;
