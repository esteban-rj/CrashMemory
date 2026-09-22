BEGIN;

-- 0007 remains reserved. Identity is populated only from a verified issuer and
-- reference in one evidence fragment. A missing anchor deliberately has no key.
ALTER TABLE extraction_candidates ADD COLUMN identity jsonb;
ALTER TABLE extraction_candidates ADD CONSTRAINT extraction_candidates_identity_shape
  CHECK (identity IS NULL OR (
    jsonb_typeof(identity) = 'object'
    AND jsonb_typeof(identity->'issuer') = 'string'
    AND jsonb_typeof(identity->'reference') = 'string'
  ));
ALTER TABLE obligations ADD COLUMN identity_hash char(64);
ALTER TABLE obligations ADD COLUMN latest_identity_observed_at timestamptz;
ALTER TABLE obligations ADD COLUMN conflict_origin_state obligation_state;
ALTER TABLE obligations ADD CONSTRAINT obligations_conflict_origin_state_check
  CHECK (conflict_origin_state IS NULL OR conflict_origin_state IN ('candidate', 'confirmed'));
ALTER TABLE obligation_versions ADD COLUMN state obligation_state;
CREATE UNIQUE INDEX obligations_owner_identity_idx
  ON obligations(user_id, identity_hash) WHERE identity_hash IS NOT NULL;

CREATE TABLE reconciliation_candidate_links (
  candidate_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (candidate_id, user_id, source_item_revision_id)
    REFERENCES extraction_candidates(id, user_id, source_item_revision_id) ON DELETE CASCADE,
  FOREIGN KEY (obligation_id, user_id)
    REFERENCES obligations(id, user_id) ON DELETE CASCADE
);

CREATE TABLE obligation_conflicts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL,
  candidate_id uuid NOT NULL UNIQUE,
  source_item_revision_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('protected_field', 'out_of_order', 'terminal_state', 'unresolved_conflict')),
  proposal jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (id, user_id, obligation_id),
  FOREIGN KEY (obligation_id, user_id)
    REFERENCES obligations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_id, user_id, source_item_revision_id)
    REFERENCES extraction_candidates(id, user_id, source_item_revision_id) ON DELETE RESTRICT
);

CREATE TRIGGER field_corrections_immutable BEFORE UPDATE ON field_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
INSERT INTO schema_migrations(version) VALUES ('0008_v06_reconciliation');
COMMIT;
