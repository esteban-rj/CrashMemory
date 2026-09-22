BEGIN;

-- This journal intentionally has no foreign keys. It must remain after an
-- account is removed and it is excluded from data snapshots, so restoring an
-- old backup cannot make deleted Gmail material eligible for ingestion again.
CREATE TABLE lifecycle_tombstones (
  id uuid PRIMARY KEY,
  tombstone_key text NOT NULL UNIQUE CHECK (length(tombstone_key) BETWEEN 1 AND 1024),
  user_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('gmail_connection', 'gmail_disconnect', 'gmail_message', 'telegram_link', 'obligation', 'account')),
  provider text,
  external_account_id text,
  source_connection_id uuid,
  external_message_id text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 100)
);
CREATE INDEX lifecycle_tombstones_lookup_idx
  ON lifecycle_tombstones(user_id, scope, provider, external_account_id, external_message_id);

ALTER TABLE users ADD COLUMN lifecycle_epoch integer NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0);
ALTER TABLE oauth_callback_nonces ADD COLUMN lifecycle_epoch integer NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0);

-- Object deletion happens after the database transaction. Retain failed
-- cleanup work without retaining any message content or credential.
CREATE TABLE lifecycle_object_cleanup (
  storage_key text PRIMARY KEY,
  user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text
);

INSERT INTO schema_migrations(version) VALUES ('0009_v09_lifecycle');
COMMIT;
