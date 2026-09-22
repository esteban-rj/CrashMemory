BEGIN;

-- 0004 is reserved for V04 Gmail.  V02's delivery_attempts table is an
-- immutable audit record, so V07 keeps preparation and resolution as separate
-- append-only facts.  A prepared row without a resolution is ambiguous after
-- a crash and is never sent again automatically.
CREATE TABLE notification_delivery_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (reminder_id, attempt_number),
  FOREIGN KEY (reminder_id, user_id)
    REFERENCES reminders(id, user_id) ON DELETE CASCADE
);
CREATE TABLE notification_delivery_resolutions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  outcome delivery_outcome NOT NULL,
  provider_message_id text,
  error_code text,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id),
  FOREIGN KEY (attempt_id, user_id)
    REFERENCES notification_delivery_attempts(id, user_id) ON DELETE CASCADE
);
CREATE INDEX notification_delivery_attempts_open_idx
  ON notification_delivery_attempts(reminder_id);

CREATE TABLE telegram_link_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX telegram_link_challenges_active_idx
  ON telegram_link_challenges(token_hash) WHERE consumed_at IS NULL;

CREATE TABLE telegram_recipients (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version text NOT NULL,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (id, user_id),
  UNIQUE (user_id),
  CHECK (octet_length(iv) = 12),
  CHECK (octet_length(auth_tag) = 16),
  CHECK ((state = 'active' AND revoked_at IS NULL) OR state = 'revoked')
);

-- Store only metadata needed for replay protection.  Chat text and command
-- content are never retained.
CREATE TABLE telegram_inbound_updates (
  bot_key text NOT NULL,
  update_id bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_key, update_id)
);
CREATE TABLE telegram_poll_offsets (
  bot_key text PRIMARY KEY,
  next_update_id bigint NOT NULL CHECK (next_update_id >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER notification_delivery_attempts_immutable BEFORE UPDATE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER notification_delivery_resolutions_immutable BEFORE UPDATE ON notification_delivery_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

INSERT INTO schema_migrations(version) VALUES ('0006_v07_telegram_reminders');
COMMIT;
