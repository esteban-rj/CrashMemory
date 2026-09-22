BEGIN;

CREATE TABLE model_budget_limits (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  limit_amount numeric NOT NULL CHECK (
    limit_amount > 0
    AND limit_amount::text ~ '^[0-9]+([.][0-9]+)?$'
    AND scale(limit_amount) <= 18
  ),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  UNIQUE (id, user_id),
  UNIQUE (user_id, currency, period_start)
);

CREATE TABLE model_budget_reservations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_limit_id uuid NOT NULL,
  operation_key text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  reserved_amount numeric NOT NULL CHECK (reserved_amount > 0),
  settled_amount numeric,
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (id, user_id),
  UNIQUE (user_id, operation_key, attempt_number),
  FOREIGN KEY (budget_limit_id, user_id)
    REFERENCES model_budget_limits(id, user_id) ON DELETE RESTRICT,
  CHECK ((state = 'settled' AND settled_amount IS NOT NULL AND settled_at IS NOT NULL)
    OR (state <> 'settled' AND settled_amount IS NULL))
);
CREATE INDEX model_budget_reservations_budget_idx
  ON model_budget_reservations(budget_limit_id, state);

CREATE TABLE extraction_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  privacy_profile text NOT NULL CHECK (privacy_profile IN ('local-only', 'remote-allowed')),
  state text NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'manual_review', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, source_item_revision_id),
  FOREIGN KEY (source_item_revision_id, user_id)
    REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE
);

CREATE TABLE extraction_pdf_pages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  page integer NOT NULL CHECK (page > 0),
  extracted_text text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attachment_id, page),
  FOREIGN KEY (attachment_id, user_id, source_item_revision_id)
    REFERENCES source_attachments(id, user_id, source_item_revision_id) ON DELETE CASCADE
);

CREATE TABLE extraction_candidates (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  amount numeric NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'manual_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_item_revision_id, user_id)
    REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE
);
CREATE TABLE extraction_candidate_evidence (
  candidate_id uuid NOT NULL REFERENCES extraction_candidates(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (candidate_id, evidence_id)
);

INSERT INTO schema_migrations(version) VALUES ('0003_v05_model_budget');
COMMIT;
