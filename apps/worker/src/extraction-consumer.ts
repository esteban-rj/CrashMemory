import { randomUUID } from "node:crypto";
import type { ConsumerRegistry } from "@crashmemory/runtime";

/**
 * Materializes extraction work inside the source-revision receipt transaction.
 * Network model calls are deliberately left to DurableExtractionRunner.
 */
export function registerExtractionConsumer(registry: ConsumerRegistry): void {
  registry.register({
    name: "extraction.enqueue.v1",
    eventTypes: ["source.item.revision.created.v1"],
    handle: async (event, client) => {
      if (event.type !== "source.item.revision.created.v1") return;
      await client.query(
        `INSERT INTO extraction_jobs(id, user_id, source_item_revision_id, privacy_profile, state)
         VALUES ($1, $2, $3, 'local-only', 'pending')
         ON CONFLICT (user_id, source_item_revision_id) DO NOTHING`,
        [randomUUID(), event.userId, event.payload.sourceItemRevisionId],
      );
    },
  });
}
