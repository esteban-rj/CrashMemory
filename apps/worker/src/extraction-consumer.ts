import { randomUUID } from "node:crypto";
import type { ConsumerRegistry } from "@crashmemory/runtime";
import type { ModelPrivacyProfile } from "@crashmemory/model-gateway";

export function loadExtractionPrivacyProfile(
  environment: NodeJS.ProcessEnv = process.env,
): ModelPrivacyProfile {
  const configured =
    environment.EXTRACTION_DEFAULT_PRIVACY_PROFILE ?? "local-only";
  if (configured === "local-only" || configured === "remote-allowed") {
    return configured;
  }
  throw new Error(
    "EXTRACTION_DEFAULT_PRIVACY_PROFILE must be local-only or remote-allowed",
  );
}

/**
 * Materializes extraction work inside the source-revision receipt transaction.
 * Network model calls are deliberately left to DurableExtractionRunner.
 */
export function registerExtractionConsumer(
  registry: ConsumerRegistry,
  privacyProfile: ModelPrivacyProfile = loadExtractionPrivacyProfile(),
): void {
  registry.register({
    name: "extraction.enqueue.v1",
    eventTypes: ["source.item.revision.created.v1"],
    handle: async (event, client) => {
      if (event.type !== "source.item.revision.created.v1") return;
      await client.query(
        `INSERT INTO extraction_jobs(id, user_id, source_item_revision_id, privacy_profile, state)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (user_id, source_item_revision_id) DO NOTHING`,
        [
          randomUUID(),
          event.userId,
          event.payload.sourceItemRevisionId,
          privacyProfile,
        ],
      );
    },
  });
}
