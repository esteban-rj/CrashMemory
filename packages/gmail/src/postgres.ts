import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  AuthorizedBlobStorage,
  type ObjectStorage,
} from "@crashmemory/runtime";
import {
  CursorRepository,
  SourceRepository,
  inTransaction,
} from "@crashmemory/db";
import {
  NORMALIZATION_VERSION,
  sha256,
  type GmailPersistence,
  type NormalizedMessage,
} from "./index.ts";

function deterministicUuid(namespace: string): string {
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A deletion fence is a normal outcome for an obsolete sync/replay job. */
export class GmailLifecycleBlockedError extends Error {
  constructor() {
    super("Gmail source is deleted or disconnected");
    this.name = "GmailLifecycleBlockedError";
  }
}

/** PostgreSQL adapter: a complete V05 input and its outbox event share one transaction. */
export class PostgresGmailPersistence implements GmailPersistence {
  private readonly blobs: AuthorizedBlobStorage;

  constructor(
    private readonly pool: Pool,
    private readonly userId: string,
    private readonly sourceConnectionId: string,
    private readonly objectStorage: ObjectStorage,
  ) {
    this.blobs = new AuthorizedBlobStorage(
      objectStorage,
      new SourceRepository(pool),
    );
  }

  private async assertWritable(externalMessageId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM source_connections connection
       WHERE connection.id = $1 AND connection.user_id = $2
         AND connection.provider = 'gmail' AND connection.state = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM lifecycle_tombstones t WHERE t.user_id = $2 AND (
             (t.scope = 'gmail_connection' AND t.source_connection_id = $1)
             OR (t.scope = 'gmail_message' AND t.provider = 'gmail'
                 AND t.external_account_id = connection.external_account_id
                 AND t.external_message_id = $3)
             OR t.scope = 'account'
           )
         )`,
      [this.sourceConnectionId, this.userId, externalMessageId],
    );
    if (result.rowCount !== 1) throw new GmailLifecycleBlockedError();
  }

  private async writeBlob(
    kind: string,
    material: Uint8Array,
    contentType: string,
  ): Promise<{ id: string; contentSha256: string; byteSize: number }> {
    const contentSha256 = sha256(material);
    const id = deterministicUuid(
      `${this.userId}:${this.sourceConnectionId}:${kind}:${contentSha256}`,
    );
    const written = await this.blobs.write({
      userId: this.userId,
      blobId: id,
      bytes: material,
      contentType,
    });
    return {
      id,
      contentSha256: written.contentSha256,
      byteSize: written.byteSize,
    };
  }

  async persistPage(input: {
    messages: NormalizedMessage[];
    reason: "bootstrap" | "incremental" | "resync";
  }): Promise<void> {
    for (const message of input.messages) {
      try {
        await this.persistMessage(message);
      } catch (error) {
        if (!(error instanceof GmailLifecycleBlockedError)) throw error;
      }
    }
  }

  private async persistMessage(message: NormalizedMessage): Promise<void> {
    // Reject before every original/body/attachment write. The transaction
    // below repeats the check before catalog rows or events are created.
    await this.assertWritable(message.externalId);
    const original = await this.writeBlob(
      "original",
      message.original,
      "message/rfc822",
    );
    const bodyBytes = asBytes(message.body);
    const body = await this.writeBlob(
      "body",
      bodyBytes,
      "text/plain; charset=utf-8",
    );
    const attachments = await Promise.all(
      message.attachments.map(async (attachment) => ({
        attachment,
        blob: await this.writeBlob(
          `attachment:${attachment.externalAttachmentId}`,
          attachment.bytes,
          attachment.mediaType,
        ),
      })),
    );
    const sourceItemId = deterministicUuid(
      `${this.userId}:${this.sourceConnectionId}:item:${message.externalId}`,
    );
    const revisionId = deterministicUuid(
      `${this.userId}:${this.sourceConnectionId}:revision:${message.externalId}:${original.contentSha256}`,
    );
    await inTransaction(this.pool, async (client) => {
      const guard = await client.query(
        `SELECT 1 FROM source_connections connection
         WHERE connection.id = $1 AND connection.user_id = $2 AND connection.state = 'active'
           AND NOT EXISTS (SELECT 1 FROM lifecycle_tombstones t WHERE t.user_id = $2
             AND ((t.scope = 'gmail_connection' AND t.source_connection_id = $1)
               OR (t.scope = 'gmail_message' AND t.provider = 'gmail'
                   AND t.external_account_id = connection.external_account_id
                   AND t.external_message_id = $3)
               OR t.scope = 'account')) FOR UPDATE`,
        [this.sourceConnectionId, this.userId, message.externalId],
      );
      if (guard.rowCount !== 1) throw new GmailLifecycleBlockedError();
      const item = await client.query<{ id: string }>(
        `INSERT INTO source_items(id, user_id, source_connection_id, external_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, source_connection_id, external_id)
         DO UPDATE SET external_id = EXCLUDED.external_id
         RETURNING id`,
        [
          sourceItemId,
          this.userId,
          this.sourceConnectionId,
          message.externalId,
        ],
      );
      const itemId = item.rows[0]?.id;
      if (!itemId) throw new Error("Gmail source item could not be resolved");
      await client.query(
        "SELECT id FROM source_items WHERE id = $1 FOR UPDATE",
        [itemId],
      );
      const revision = await client.query<{ id: string }>(
        `INSERT INTO source_item_revisions(
           id, user_id, source_item_id, revision, original_blob_id, content_sha256, observed_at
         ) VALUES (
           $1, $2, $3,
           (SELECT COALESCE(MAX(revision), 0) + 1 FROM source_item_revisions WHERE source_item_id = $3),
           $4, $5, now()
         ) ON CONFLICT (source_item_id, content_sha256) DO NOTHING RETURNING id`,
        [revisionId, this.userId, itemId, original.id, original.contentSha256],
      );
      // A prior transaction committed this entire revision, so a replay must
      // not emit another event or append duplicate children.
      if (revision.rowCount === 0) return;
      await client.query(
        `INSERT INTO source_revision_bodies(
           id, user_id, source_item_revision_id, body_blob_id, content_sha256,
           utf16_length, normalization_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          deterministicUuid(`${revisionId}:body`),
          this.userId,
          revisionId,
          body.id,
          body.contentSha256,
          message.body.length,
          NORMALIZATION_VERSION,
        ],
      );
      for (const entry of attachments) {
        await client.query(
          `INSERT INTO source_attachments(
             id, user_id, source_item_revision_id, external_attachment_id, blob_id,
             file_name, media_type, byte_size, content_sha256
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            deterministicUuid(
              `${revisionId}:attachment:${entry.attachment.externalAttachmentId}`,
            ),
            this.userId,
            revisionId,
            entry.attachment.externalAttachmentId,
            entry.blob.id,
            entry.attachment.fileName,
            entry.attachment.mediaType,
            entry.blob.byteSize,
            entry.blob.contentSha256,
          ],
        );
      }
      const eventId = deterministicUuid(
        `${revisionId}:source.item.revision.created.v1`,
      );
      await client.query(
        `INSERT INTO outbox_events(
           id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key, occurred_at, payload
         ) VALUES ($1, $2, 'source.item.revision.created.v1', 'source_item', $3, $4, now(), $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          eventId,
          this.userId,
          itemId,
          `gmail:revision:${revisionId}`,
          { sourceItemId: itemId, sourceItemRevisionId: revisionId },
        ],
      );
    });
  }

  async confirmCursor(historyId: string): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await new CursorRepository(client).upsert({
        id: deterministicUuid(`${this.sourceConnectionId}:cursor`),
        userId: this.userId,
        sourceConnectionId: this.sourceConnectionId,
        cursorValue: historyId,
        observedAt: new Date(),
      });
      await client.query(
        `UPDATE source_connections SET last_sync_at = now(), last_sync_error_code = NULL,
         updated_at = now() WHERE id = $1 AND user_id = $2`,
        [this.sourceConnectionId, this.userId],
      );
    });
  }

  async recordWatch(input: {
    historyId: string;
    expiration: Date;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE source_connections SET watch_expiration_at = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [this.sourceConnectionId, this.userId, input.expiration],
    );
  }

  async recordSyncFailure(
    code: "history_not_found" | "reauth_required",
  ): Promise<void> {
    await this.pool.query(
      `UPDATE source_connections SET state = CASE WHEN $3 = 'reauth_required' THEN 'error' ELSE state END,
       last_sync_error_code = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [this.sourceConnectionId, this.userId, code],
    );
  }
}
