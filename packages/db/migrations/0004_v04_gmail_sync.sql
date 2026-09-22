BEGIN;

ALTER TABLE source_connections
  ADD COLUMN oauth_authorized_at timestamptz,
  ADD COLUMN watch_expiration_at timestamptz,
  ADD COLUMN last_sync_at timestamptz,
  ADD COLUMN last_sync_error_code text;

ALTER TABLE encrypted_credentials
  ADD CONSTRAINT encrypted_credentials_one_per_connection UNIQUE (source_connection_id);

CREATE TABLE gmail_push_notifications (
  source_connection_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_history_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_connection_id, user_id)
    REFERENCES source_connections(id, user_id) ON DELETE CASCADE
);

INSERT INTO schema_migrations(version) VALUES ('0004_v04_gmail_sync');
COMMIT;
