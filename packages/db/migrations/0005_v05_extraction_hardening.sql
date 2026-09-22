BEGIN;

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_revision_id uuid NOT NULL, privacy_profile text NOT NULL CHECK (privacy_profile IN ('local-only', 'remote-allowed')),
  state text NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'manual_review', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (user_id, source_item_revision_id), FOREIGN KEY (source_item_revision_id, user_id) REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS extraction_pdf_pages (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_item_revision_id uuid NOT NULL,
  attachment_id uuid NOT NULL, page integer NOT NULL CHECK (page > 0), extracted_text text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attachment_id, page), FOREIGN KEY (attachment_id, user_id, source_item_revision_id) REFERENCES source_attachments(id, user_id, source_item_revision_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS extraction_candidates (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_item_revision_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500), amount numeric NOT NULL CHECK (amount > 0), currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due jsonb NOT NULL, state text NOT NULL CHECK (state IN ('ready', 'manual_review')), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_item_revision_id, user_id) REFERENCES source_item_revisions(id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS extraction_candidate_evidence (
  candidate_id uuid NOT NULL REFERENCES extraction_candidates(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT, PRIMARY KEY (candidate_id, evidence_id)
);
ALTER TABLE extraction_jobs ADD COLUMN claimed_at timestamptz;
ALTER TABLE extraction_candidates ADD COLUMN extraction_job_id uuid;
ALTER TABLE extraction_candidates
  ADD CONSTRAINT extraction_candidates_job_fk FOREIGN KEY (extraction_job_id)
  REFERENCES extraction_jobs(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX extraction_candidates_job_id_idx
  ON extraction_candidates(extraction_job_id, id);
ALTER TABLE extraction_candidates ADD CONSTRAINT extraction_candidates_owner_revision_unique
  UNIQUE (id, user_id, source_item_revision_id);
ALTER TABLE evidence ADD CONSTRAINT evidence_owner_revision_unique
  UNIQUE (id, user_id, source_item_revision_id);
ALTER TABLE extraction_candidate_evidence ADD COLUMN user_id uuid;
ALTER TABLE extraction_candidate_evidence ADD COLUMN source_item_revision_id uuid;
UPDATE extraction_candidate_evidence link
SET user_id = candidate.user_id, source_item_revision_id = candidate.source_item_revision_id
FROM extraction_candidates candidate WHERE candidate.id = link.candidate_id;
ALTER TABLE extraction_candidate_evidence ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE extraction_candidate_evidence ALTER COLUMN source_item_revision_id SET NOT NULL;
ALTER TABLE extraction_candidate_evidence
  ADD CONSTRAINT extraction_candidate_evidence_candidate_fk
  FOREIGN KEY (candidate_id, user_id, source_item_revision_id)
  REFERENCES extraction_candidates(id, user_id, source_item_revision_id) ON DELETE CASCADE;
ALTER TABLE extraction_candidate_evidence
  ADD CONSTRAINT extraction_candidate_evidence_evidence_fk
  FOREIGN KEY (evidence_id, user_id, source_item_revision_id)
  REFERENCES evidence(id, user_id, source_item_revision_id) ON DELETE RESTRICT;
INSERT INTO schema_migrations(version) VALUES ('0005_v05_extraction_hardening');
COMMIT;
