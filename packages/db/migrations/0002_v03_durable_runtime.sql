BEGIN;

-- V03: PostgreSQL remains the authority for dispatch and consumer completion.
-- Redis/BullMQ contains recoverable copies only.

CREATE TABLE outbox_dispatch_attempts (
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  job_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('prepared', 'enqueued', 'failed')),
  error_code text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  PRIMARY KEY (event_id, attempt_number),
  CHECK ((state = 'enqueued') = (enqueued_at IS NOT NULL))
);
CREATE INDEX outbox_dispatch_attempts_recovery_idx
  ON outbox_dispatch_attempts(state, prepared_at);

CREATE TABLE event_consumer_receipts (
  consumer_name text NOT NULL CHECK (length(consumer_name) BETWEEN 1 AND 160),
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  effect_started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX event_consumer_receipts_pending_idx
  ON event_consumer_receipts(event_id, state) WHERE state <> 'completed';

INSERT INTO schema_migrations(version) VALUES ('0002_v03_durable_runtime');
COMMIT;
