BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE model_budget_limits
  ADD CONSTRAINT model_budget_limits_no_overlapping_periods
  EXCLUDE USING gist (
    user_id WITH =,
    currency WITH =,
    tstzrange(period_start, period_end, '[)') WITH &&
  );

INSERT INTO schema_migrations(version) VALUES ('0007_v05_model_budget_periods');

COMMIT;
