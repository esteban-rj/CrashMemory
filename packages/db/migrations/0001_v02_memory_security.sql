BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_state AS ENUM ('active', 'disabled');
CREATE TYPE connection_state AS ENUM ('pending', 'active', 'revoked', 'error');
CREATE TYPE obligation_state AS ENUM ('candidate', 'confirmed', 'conflict', 'paid', 'discarded');
CREATE TYPE evidence_kind AS ENUM ('email_body_fragment', 'pdf_text_fragment');
CREATE TYPE due_kind AS ENUM ('civil_date', 'instant');
CREATE TYPE reminder_state AS ENUM ('scheduled', 'cancelled', 'delivering', 'resolved');
CREATE TYPE delivery_outcome AS ENUM ('sent', 'failed', 'unknown');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  time_zone text NOT NULL,
  state user_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalized = lower(email_normalized)),
  UNIQUE (id, email_normalized)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE (id, user_id)
);
CREATE INDEX auth_sessions_active_token_idx ON auth_sessions(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE source_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'gmail'),
  external_account_id text NOT NULL,
  state connection_state NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, provider, external_account_id)
);

CREATE TABLE encrypted_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_connection_id uuid NOT NULL,
  key_version text NOT NULL,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_connection_id),
  FOREIGN KEY (source_connection_id, user_id)
    REFERENCES source_connections(id, user_id) ON DELETE CASCADE,
  CHECK (octet_length(iv) = 12),
  CHECK (octet_length(auth_tag) = 16)
);

CREATE TABLE blobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (storage_key)
);

CREATE TABLE source_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_connection_id uuid NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, source_connection_id, external_id),
  FOREIGN KEY (source_connection_id, user_id)
    REFERENCES source_connections(id, user_id) ON DELETE CASCADE
);

CREATE TABLE source_item_revisions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  original_blob_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (source_item_id, revision),
  UNIQUE (source_item_id, content_sha256),
  FOREIGN KEY (source_item_id, user_id)
    REFERENCES source_items(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (original_blob_id, user_id)
    REFERENCES blobs(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE source_revision_bodies (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  body_blob_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  utf16_length integer NOT NULL CHECK (utf16_length >= 0),
  normalization_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_item_revision_id),
  UNIQUE (id, user_id),
  FOREIGN KEY (source_item_revision_id, user_id)
    REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (body_blob_id, user_id)
    REFERENCES blobs(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE source_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  external_attachment_id text NOT NULL,
  blob_id uuid NOT NULL,
  file_name text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, source_item_revision_id),
  UNIQUE (source_item_revision_id, external_attachment_id),
  FOREIGN KEY (source_item_revision_id, user_id)
    REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (blob_id, user_id)
    REFERENCES blobs(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  kind evidence_kind NOT NULL,
  attachment_id uuid,
  page integer,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  quote text NOT NULL CHECK (length(quote) BETWEEN 1 AND 4000),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (source_item_revision_id, user_id)
    REFERENCES source_item_revisions(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (attachment_id, user_id, source_item_revision_id)
    REFERENCES source_attachments(id, user_id, source_item_revision_id) ON DELETE RESTRICT,
  CHECK ((
    (kind = 'email_body_fragment' AND attachment_id IS NULL AND page IS NULL)
    OR
    (kind = 'pdf_text_fragment' AND attachment_id IS NOT NULL AND page IS NOT NULL AND page > 0)
  ) IS TRUE)
);

CREATE TABLE obligations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state obligation_state NOT NULL DEFAULT 'candidate',
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE obligation_versions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  amount numeric,
  currency char(3),
  due_kind due_kind,
  due_date date,
  due_at timestamptz,
  time_zone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, obligation_id),
  UNIQUE (obligation_id, revision),
  FOREIGN KEY (obligation_id, user_id)
    REFERENCES obligations(id, user_id) ON DELETE CASCADE,
  CHECK ((
    (amount IS NULL AND currency IS NULL)
    OR (
      amount IS NOT NULL AND amount > 0 AND currency IS NOT NULL
      AND amount::text ~ '^[0-9]+([.][0-9]+)?$'
      AND currency ~ '^[A-Z]{3}$'
      AND scale(amount) <= 18
      AND length(replace(replace(amount::text, '.', ''), '-', '')) <= 38
    )
  ) IS TRUE),
  CHECK ((
    (due_kind IS NULL AND due_date IS NULL AND due_at IS NULL AND time_zone IS NULL)
    OR
    (due_kind IS NOT NULL AND due_kind = 'civil_date' AND due_date IS NOT NULL AND due_at IS NULL AND time_zone IS NOT NULL)
    OR
    (due_kind IS NOT NULL AND due_kind = 'instant' AND due_date IS NULL AND due_at IS NOT NULL AND time_zone IS NOT NULL)
  ) IS TRUE)
);

ALTER TABLE obligations
  ADD CONSTRAINT obligations_current_version_owner_fk
  FOREIGN KEY (current_version_id, user_id, id)
  REFERENCES obligation_versions(id, user_id, obligation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE obligation_version_evidence (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obligation_version_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (obligation_version_id, evidence_id),
  FOREIGN KEY (obligation_version_id, user_id)
    REFERENCES obligation_versions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, user_id)
    REFERENCES evidence(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE field_corrections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL,
  based_on_version_id uuid NOT NULL,
  field_name text NOT NULL CHECK (field_name IN ('title', 'amount', 'due', 'state')),
  corrected_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (obligation_id, user_id)
    REFERENCES obligations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (based_on_version_id, user_id, obligation_id)
    REFERENCES obligation_versions(id, user_id, obligation_id) ON DELETE RESTRICT
);

CREATE TABLE sync_cursors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_connection_id uuid NOT NULL,
  cursor_value text NOT NULL,
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_connection_id),
  UNIQUE (id, user_id),
  FOREIGN KEY (source_connection_id, user_id)
    REFERENCES source_connections(id, user_id) ON DELETE CASCADE
);

CREATE TABLE oauth_callback_nonces (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'gmail'),
  nonce_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (auth_session_id, user_id)
    REFERENCES auth_sessions(id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX oauth_callback_nonces_active_idx
  ON oauth_callback_nonces(nonce_hash) WHERE consumed_at IS NULL;

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type ~ '[.]v1$'),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  claimed_at timestamptz,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE TABLE reminders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL,
  obligation_version_id uuid NOT NULL,
  target_version integer NOT NULL CHECK (target_version > 0),
  state reminder_state NOT NULL DEFAULT 'scheduled',
  scheduled_for timestamptz NOT NULL,
  policy jsonb NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, dedupe_key),
  FOREIGN KEY (obligation_id, user_id)
    REFERENCES obligations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (obligation_version_id, user_id, obligation_id)
    REFERENCES obligation_versions(id, user_id, obligation_id) ON DELETE RESTRICT
);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome delivery_outcome NOT NULL,
  provider_message_id text,
  error_code text,
  resolved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (reminder_id, attempt_number),
  FOREIGN KEY (reminder_id, user_id)
    REFERENCES reminders(id, user_id) ON DELETE CASCADE
);

CREATE TABLE model_usage_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  entry_sequence integer NOT NULL CHECK (entry_sequence > 0),
  provider text NOT NULL,
  model text NOT NULL,
  pricing_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'estimated', 'billed', 'unknown', 'released')),
  input_units bigint CHECK (input_units IS NULL OR input_units >= 0),
  output_units bigint CHECK (output_units IS NULL OR output_units >= 0),
  cost_amount numeric,
  cost_currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, operation_key, entry_sequence),
  CHECK ((
    (cost_amount IS NULL AND cost_currency IS NULL)
    OR (
      cost_amount IS NOT NULL AND cost_amount >= 0 AND cost_currency IS NOT NULL
      AND cost_amount::text ~ '^[0-9]+([.][0-9]+)?$'
      AND cost_currency ~ '^[A-Z]{3}$'
      AND scale(cost_amount) <= 18
      AND length(replace(replace(cost_amount::text, '.', ''), '-', '')) <= 38
    )
  ) IS TRUE)
);

CREATE TABLE audit_ledger_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_session_id, user_id)
    REFERENCES auth_sessions(id, user_id) ON DELETE SET NULL (actor_session_id)
);

CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % cannot be changed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_item_revisions_immutable BEFORE UPDATE ON source_item_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER source_revision_bodies_immutable BEFORE UPDATE ON source_revision_bodies
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER source_attachments_immutable BEFORE UPDATE ON source_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER evidence_immutable BEFORE UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER obligation_versions_immutable BEFORE UPDATE ON obligation_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER delivery_attempts_immutable BEFORE UPDATE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER model_usage_ledger_immutable BEFORE UPDATE ON model_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_ledger_entries_immutable BEFORE UPDATE ON audit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

INSERT INTO schema_migrations(version) VALUES ('0001_v02_memory_security');
COMMIT;
