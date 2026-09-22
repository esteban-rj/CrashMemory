BEGIN;

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
