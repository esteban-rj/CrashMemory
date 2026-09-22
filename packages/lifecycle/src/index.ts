import { randomUUID } from "node:crypto";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "@crashmemory/db";
import type { ObjectStorage } from "@crashmemory/runtime";

export class LifecycleNotFoundError extends Error {
  constructor() {
    super("Lifecycle target was not found for this owner");
    this.name = "LifecycleNotFoundError";
  }
}

export class LifecycleStorageRequiredError extends Error {
  constructor() {
    super("Object storage is required to remove source originals safely");
    this.name = "LifecycleStorageRequiredError";
  }
}
export class LifecycleJournalRequiredError extends Error {
  constructor() {
    super("A durable encrypted lifecycle journal is required");
    this.name = "LifecycleJournalRequiredError";
  }
}

export interface DeletionJournal {
  /** Must fsync before resolving; stale intents are conservatively replayed. */
  append(entry: Record<string, unknown>): Promise<void>;
}
export interface GmailRemoteRevoker {
  revoke(input: {
    userId: string;
    connectionId: string;
    encrypted: {
      keyVersion: string;
      iv: string;
      ciphertext: string;
      authTag: string;
    };
  }): Promise<"revoked" | "failed">;
}

/** Append-only AES-256-GCM journal, deliberately separate from PostgreSQL dumps. */
export class EncryptedFileDeletionJournal implements DeletionJournal {
  private readonly key: Buffer;
  constructor(
    private readonly path: string,
    keyBase64: string,
  ) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.byteLength !== 32)
      throw new Error("Lifecycle journal key must be 32 bytes base64");
  }
  async append(entry: Record<string, unknown>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(entry), "utf8"),
      cipher.final(),
    ]);
    const line =
      JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      }) + "\n";
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export interface LifecycleResult {
  deletedSourceItems: number;
  deletedObligations: number;
  cancelledReminders: number;
  pendingObjectCleanup: number;
}

function key(...parts: string[]): string {
  return parts.join(":");
}

async function addTombstone(
  client: PoolClient,
  input: {
    tombstoneKey: string;
    userId: string;
    scope:
      | "gmail_connection"
      | "gmail_message"
      | "telegram_link"
      | "obligation"
      | "account";
    provider?: "gmail";
    externalAccountId?: string;
    sourceConnectionId?: string;
    externalMessageId?: string;
    reason: string;
  },
  journal?: DeletionJournal,
): Promise<void> {
  // The intent is durable before the DB transaction may commit. If the SQL
  // rolls back, replaying this extra intent remains privacy-conservative.
  if (journal)
    await journal.append({ ...input, recordedAt: new Date().toISOString() });
  await client.query(
    `INSERT INTO lifecycle_tombstones(
       id, tombstone_key, user_id, scope, provider, external_account_id,
       source_connection_id, external_message_id, reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tombstone_key) DO NOTHING`,
    [
      randomUUID(),
      input.tombstoneKey,
      input.userId,
      input.scope,
      input.provider ?? null,
      input.externalAccountId ?? null,
      input.sourceConnectionId ?? null,
      input.externalMessageId ?? null,
      input.reason,
    ],
  );
}

/**
 * Lifecycle mutations are local and transactional. They deliberately never
 * claim that a remote Google revoke succeeded: credentials are removed and
 * local writers are fenced first, which makes retries/replays harmless.
 */
export class LifecycleService {
  constructor(
    private readonly pool: Pool,
    private readonly storage?: ObjectStorage,
    private readonly journal?: DeletionJournal,
    private readonly gmailRevoker?: GmailRemoteRevoker,
  ) {}
  private requireJournal(): DeletionJournal {
    if (!this.journal) throw new LifecycleJournalRequiredError();
    return this.journal;
  }

  private async lockUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
      [`lifecycle:user:${userId}`],
    );
  }

  async disconnectGmail(input: {
    userId: string;
    connectionId: string;
    actorSessionId: string;
  }): Promise<"revoked" | "not_configured" | "failed"> {
    this.requireJournal();
    const credential = await inTransaction(this.pool, async (client) => {
      await this.lockUser(client, input.userId);
      const connection = await client.query<{ id: string }>(
        `SELECT id FROM source_connections WHERE id = $1 AND user_id = $2 AND provider = 'gmail' FOR UPDATE`,
        [input.connectionId, input.userId],
      );
      if (connection.rowCount !== 1) throw new LifecycleNotFoundError();
      const stored = await client.query<Record<string, unknown>>(
        "SELECT key_version, iv, ciphertext, auth_tag FROM encrypted_credentials WHERE user_id = $1 AND source_connection_id = $2 FOR UPDATE",
        [input.userId, input.connectionId],
      );
      // Invalidates any callback issued before disconnect. A newly initiated
      // OAuth consent creates a new nonce and may explicitly reconnect later.
      await client.query(
        `DELETE FROM oauth_callback_nonces WHERE user_id = $1 AND provider = 'gmail' AND consumed_at IS NULL`,
        [input.userId],
      );
      await client.query(
        "UPDATE users SET lifecycle_epoch = lifecycle_epoch + 1 WHERE id = $1",
        [input.userId],
      );
      await client.query(
        "DELETE FROM encrypted_credentials WHERE user_id = $1 AND source_connection_id = $2",
        [input.userId, input.connectionId],
      );
      await client.query(
        "DELETE FROM gmail_push_notifications WHERE source_connection_id = $1",
        [input.connectionId],
      );
      await client.query(
        "UPDATE source_connections SET state = 'revoked', updated_at = now() WHERE id = $1 AND user_id = $2",
        [input.connectionId, input.userId],
      );
      await client.query(
        `INSERT INTO audit_ledger_entries(id,user_id,actor_session_id,action,target_type,target_id)
         VALUES ($1,$2,$3,'gmail.disconnected','source_connection',$4)`,
        [randomUUID(), input.userId, input.actorSessionId, input.connectionId],
      );
      if (stored.rowCount !== 1) return null;
      const row = stored.rows[0]!;
      return {
        keyVersion: String(row.key_version),
        iv: Buffer.from(row.iv as Buffer).toString("base64"),
        ciphertext: Buffer.from(row.ciphertext as Buffer).toString("base64"),
        authTag: Buffer.from(row.auth_tag as Buffer).toString("base64"),
      };
    });
    if (!credential || !this.gmailRevoker) return "not_configured";
    try {
      return await this.gmailRevoker.revoke({
        userId: input.userId,
        connectionId: input.connectionId,
        encrypted: credential,
      });
    } catch {
      return "failed";
    }
  }

  async unlinkTelegram(input: {
    userId: string;
    actorSessionId: string;
  }): Promise<number> {
    const journal = this.requireJournal();
    return inTransaction(this.pool, async (client) => {
      await this.lockUser(client, input.userId);
      await addTombstone(
        client,
        {
          tombstoneKey: key(input.userId, "telegram"),
          userId: input.userId,
          scope: "telegram_link",
          reason: "user_unlinked",
        },
        journal,
      );
      await client.query(
        "DELETE FROM telegram_link_challenges WHERE user_id = $1",
        [input.userId],
      );
      await client.query(
        "UPDATE telegram_recipients SET state = 'revoked', revoked_at = now() WHERE user_id = $1 AND state = 'active'",
        [input.userId],
      );
      const cancelled = await client.query(
        `UPDATE reminders SET state = 'cancelled', updated_at = now()
         WHERE user_id = $1 AND state IN ('scheduled', 'delivering')`,
        [input.userId],
      );
      await client.query(
        `DELETE FROM outbox_events WHERE user_id = $1 AND event_type = 'reminder.delivery.requested.v1'`,
        [input.userId],
      );
      await client.query(
        `INSERT INTO audit_ledger_entries(id,user_id,actor_session_id,action,target_type)
         VALUES ($1,$2,$3,'telegram.unlinked','telegram_recipient')`,
        [randomUUID(), input.userId, input.actorSessionId],
      );
      return cancelled.rowCount ?? 0;
    });
  }

  async deleteSourceConnection(input: {
    userId: string;
    connectionId: string;
    actorSessionId: string;
  }): Promise<LifecycleResult> {
    return this.deleteSource(input, undefined);
  }

  async deleteSourceItem(input: {
    userId: string;
    connectionId: string;
    externalMessageId: string;
    actorSessionId: string;
  }): Promise<LifecycleResult> {
    return this.deleteSource(input, input.externalMessageId);
  }

  private async deleteSource(
    input: { userId: string; connectionId: string; actorSessionId: string },
    onlyExternalMessageId?: string,
  ): Promise<LifecycleResult> {
    // Refuse before the DB mutation when originals cannot be removed. This
    // avoids acknowledging a privacy deletion while leaving object bytes.
    if (!this.storage) throw new LifecycleStorageRequiredError();
    const journal = this.requireJournal();
    const result = await inTransaction(this.pool, async (client) => {
      await this.lockUser(client, input.userId);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
        [`lifecycle:gmail:${input.userId}:${input.connectionId}`],
      );
      const connection = await client.query<{ external_account_id: string }>(
        `SELECT external_account_id FROM source_connections
         WHERE id = $1 AND user_id = $2 AND provider = 'gmail' FOR UPDATE`,
        [input.connectionId, input.userId],
      );
      if (connection.rowCount !== 1) throw new LifecycleNotFoundError();
      const externalAccountId = connection.rows[0]!.external_account_id;
      // A callback that already exchanged a code must still fail its epoch
      // check before storing a credential for this deleted source.
      await client.query(
        "DELETE FROM oauth_callback_nonces WHERE user_id = $1 AND provider = 'gmail' AND consumed_at IS NULL",
        [input.userId],
      );
      await client.query(
        "UPDATE users SET lifecycle_epoch = lifecycle_epoch + 1 WHERE id = $1",
        [input.userId],
      );
      const items = await client.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM source_items WHERE user_id = $1 AND source_connection_id = $2
         AND ($3::text IS NULL OR external_id = $3) FOR UPDATE`,
        [input.userId, input.connectionId, onlyExternalMessageId ?? null],
      );
      if (onlyExternalMessageId && items.rowCount !== 1)
        throw new LifecycleNotFoundError();
      if (!onlyExternalMessageId) {
        await addTombstone(
          client,
          {
            tombstoneKey: key(
              input.userId,
              "gmail",
              "connection",
              input.connectionId,
            ),
            userId: input.userId,
            scope: "gmail_connection",
            provider: "gmail",
            externalAccountId,
            sourceConnectionId: input.connectionId,
            reason: "source_deleted",
          },
          journal,
        );
      }
      for (const item of items.rows) {
        await addTombstone(
          client,
          {
            tombstoneKey: key(
              input.userId,
              "gmail",
              externalAccountId,
              "message",
              item.external_id,
            ),
            userId: input.userId,
            scope: "gmail_message",
            provider: "gmail",
            externalAccountId,
            sourceConnectionId: input.connectionId,
            externalMessageId: item.external_id,
            reason: "source_deleted",
          },
          journal,
        );
      }
      const itemIds = items.rows.map((item) => item.id);
      if (itemIds.length === 0) {
        if (!onlyExternalMessageId)
          await client.query(
            "DELETE FROM source_connections WHERE id = $1 AND user_id = $2",
            [input.connectionId, input.userId],
          );
        return {
          keys: [] as string[],
          deletedSourceItems: 0,
          deletedObligations: 0,
          cancelledReminders: 0,
        };
      }
      const revisions = await client.query<{ id: string }>(
        "SELECT id FROM source_item_revisions WHERE user_id = $1 AND source_item_id = ANY($2::uuid[])",
        [input.userId, itemIds],
      );
      const revisionIds = revisions.rows.map((row) => row.id);
      const blobs = await client.query<{ storage_key: string }>(
        `SELECT DISTINCT b.storage_key FROM blobs b
         LEFT JOIN source_item_revisions r ON r.original_blob_id = b.id
         LEFT JOIN source_revision_bodies body ON body.body_blob_id = b.id
         LEFT JOIN source_attachments attachment ON attachment.blob_id = b.id
         WHERE b.user_id = $1 AND (r.id = ANY($2::uuid[]) OR body.source_item_revision_id = ANY($2::uuid[]) OR attachment.source_item_revision_id = ANY($2::uuid[]))`,
        [input.userId, revisionIds],
      );
      const affected = await client.query<{ id: string }>(
        `SELECT DISTINCT v.obligation_id AS id
         FROM obligation_version_evidence link
         JOIN obligation_versions v ON v.id = link.obligation_version_id
         JOIN evidence e ON e.id = link.evidence_id
         WHERE link.user_id = $1 AND e.source_item_revision_id = ANY($2::uuid[])`,
        [input.userId, revisionIds],
      );
      const affectedIds = affected.rows.map((row) => row.id);
      const cancelled =
        affectedIds.length === 0
          ? 0
          : ((
              await client.query(
                `UPDATE reminders SET state = 'cancelled', updated_at = now()
         WHERE user_id = $1 AND obligation_id = ANY($2::uuid[]) AND state IN ('scheduled','delivering')`,
                [input.userId, affectedIds],
              )
            ).rowCount ?? 0);
      await client.query(
        `DELETE FROM outbox_events WHERE user_id = $1
         AND payload->>'sourceItemRevisionId' = ANY($2::text[])`,
        [input.userId, revisionIds],
      );
      await client.query(
        `DELETE FROM obligation_conflicts WHERE user_id = $1 AND source_item_revision_id = ANY($2::uuid[])`,
        [input.userId, revisionIds],
      );
      await client.query(
        `DELETE FROM extraction_candidate_evidence WHERE user_id = $1 AND source_item_revision_id = ANY($2::uuid[])`,
        [input.userId, revisionIds],
      );
      await client.query(
        `DELETE FROM obligation_version_evidence link USING evidence e
         WHERE link.evidence_id = e.id AND link.user_id = $1 AND e.source_item_revision_id = ANY($2::uuid[])`,
        [input.userId, revisionIds],
      );
      await client.query(
        "DELETE FROM evidence WHERE user_id = $1 AND source_item_revision_id = ANY($2::uuid[])",
        [input.userId, revisionIds],
      );
      await client.query(
        "DELETE FROM source_items WHERE user_id = $1 AND id = ANY($2::uuid[])",
        [input.userId, itemIds],
      );
      const unsupported =
        affectedIds.length === 0
          ? { rowCount: 0 }
          : await client.query(
              `DELETE FROM obligations o WHERE o.user_id = $1 AND o.id = ANY($2::uuid[])
         -- A partial correction only protects the fields it names; this
         -- relational version cannot truthfully preserve inferred siblings
         -- without their evidence. Full confirm/correct provenance has all
         -- three fields and may survive source loss as manual knowledge.
         AND NOT EXISTS (
           SELECT 1 FROM field_corrections c WHERE c.obligation_id = o.id AND c.user_id = o.user_id
           GROUP BY c.obligation_id HAVING COUNT(DISTINCT c.field_name) = 3
         )
         AND NOT EXISTS (
           SELECT 1 FROM obligation_version_evidence link
           JOIN evidence e ON e.id = link.evidence_id AND e.user_id = link.user_id
           WHERE link.user_id = o.user_id AND link.obligation_version_id = o.current_version_id
         )`,
              [input.userId, affectedIds],
            );
      // A blob becomes unreachable only after all source rows are gone. Never
      // remove a shared object just because one source revision was erased.
      const deletedBlobs = await client.query<{ storage_key: string }>(
        `DELETE FROM blobs b WHERE b.user_id = $1 AND b.storage_key = ANY($2::text[])
         AND NOT EXISTS (SELECT 1 FROM source_item_revisions r WHERE r.original_blob_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM source_revision_bodies body WHERE body.body_blob_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM source_attachments attachment WHERE attachment.blob_id = b.id)
         RETURNING storage_key`,
        [input.userId, blobs.rows.map((row) => row.storage_key)],
      );
      for (const blob of deletedBlobs.rows) {
        await client.query(
          `INSERT INTO lifecycle_object_cleanup(storage_key,user_id)
           VALUES ($1,$2) ON CONFLICT (storage_key) DO NOTHING`,
          [blob.storage_key, input.userId],
        );
      }
      if (!onlyExternalMessageId)
        await client.query(
          "DELETE FROM source_connections WHERE id = $1 AND user_id = $2",
          [input.connectionId, input.userId],
        );
      await client.query(
        `INSERT INTO audit_ledger_entries(id,user_id,actor_session_id,action,target_type,target_id,details)
         VALUES ($1,$2,$3,'source.deleted','source_connection',$4,$5)`,
        [
          randomUUID(),
          input.userId,
          input.actorSessionId,
          input.connectionId,
          { sourceItems: itemIds.length },
        ],
      );
      return {
        keys: deletedBlobs.rows.map((row) => row.storage_key),
        deletedSourceItems: itemIds.length,
        deletedObligations: unsupported.rowCount ?? 0,
        cancelledReminders: cancelled,
      };
    });
    const pendingObjectCleanup = await this.removeObjects(
      input.userId,
      result.keys,
    );
    return {
      deletedSourceItems: result.deletedSourceItems,
      deletedObligations: result.deletedObligations,
      cancelledReminders: result.cancelledReminders,
      pendingObjectCleanup,
    };
  }

  async deleteAccount(input: {
    userId: string;
  }): Promise<{ pendingObjectCleanup: number }> {
    if (!this.storage) throw new LifecycleStorageRequiredError();
    const journal = this.requireJournal();
    const result = await inTransaction(this.pool, async (client) => {
      await this.lockUser(client, input.userId);
      await addTombstone(
        client,
        {
          tombstoneKey: key(input.userId, "account"),
          userId: input.userId,
          scope: "account",
          reason: "account_deleted",
        },
        journal,
      );
      const blobs = await client.query<{ storage_key: string }>(
        "SELECT storage_key FROM blobs WHERE user_id = $1",
        [input.userId],
      );
      for (const blob of blobs.rows) {
        await client.query(
          `INSERT INTO lifecycle_object_cleanup(storage_key,user_id)
           VALUES ($1,$2) ON CONFLICT (storage_key) DO NOTHING`,
          [blob.storage_key, input.userId],
        );
      }
      const removed = await client.query("DELETE FROM users WHERE id = $1", [
        input.userId,
      ]);
      if (removed.rowCount !== 1) throw new LifecycleNotFoundError();
      return blobs.rows.map((row) => row.storage_key);
    });
    return {
      pendingObjectCleanup: await this.removeObjects(input.userId, result),
    };
  }

  /** Deletes generated knowledge while fencing every source message that supported it. */
  async deleteObligation(input: {
    userId: string;
    obligationId: string;
    actorSessionId: string;
  }): Promise<void> {
    const journal = this.requireJournal();
    await inTransaction(this.pool, async (client) => {
      await this.lockUser(client, input.userId);
      const obligation = await client.query(
        "SELECT id FROM obligations WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.obligationId, input.userId],
      );
      if (obligation.rowCount !== 1) throw new LifecycleNotFoundError();
      await addTombstone(
        client,
        {
          tombstoneKey: key(input.userId, "obligation", input.obligationId),
          userId: input.userId,
          scope: "obligation",
          reason: "knowledge_deleted",
        },
        journal,
      );
      const supports = await client.query<{
        external_account_id: string;
        external_id: string;
      }>(
        `SELECT DISTINCT connection.external_account_id, item.external_id
         FROM obligation_version_evidence link
         JOIN evidence e ON e.id = link.evidence_id
         JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
         JOIN source_items item ON item.id = revision.source_item_id
         JOIN source_connections connection ON connection.id = item.source_connection_id
         WHERE link.user_id = $1 AND link.obligation_version_id IN
           (SELECT id FROM obligation_versions WHERE obligation_id = $2 AND user_id = $1)`,
        [input.userId, input.obligationId],
      );
      for (const support of supports.rows)
        await addTombstone(
          client,
          {
            tombstoneKey: key(
              input.userId,
              "gmail",
              support.external_account_id,
              "message",
              support.external_id,
            ),
            userId: input.userId,
            scope: "gmail_message",
            provider: "gmail",
            externalAccountId: support.external_account_id,
            externalMessageId: support.external_id,
            reason: "knowledge_deleted",
          },
          journal,
        );
      await client.query(
        "UPDATE reminders SET state = 'cancelled', updated_at = now() WHERE user_id = $1 AND obligation_id = $2 AND state IN ('scheduled','delivering')",
        [input.userId, input.obligationId],
      );
      await client.query(
        "DELETE FROM outbox_events WHERE user_id = $1 AND aggregate_id = $2",
        [input.userId, input.obligationId],
      );
      await client.query(
        "DELETE FROM obligations WHERE id = $1 AND user_id = $2",
        [input.obligationId, input.userId],
      );
      await client.query(
        `INSERT INTO audit_ledger_entries(id,user_id,actor_session_id,action,target_type,target_id)
         VALUES ($1,$2,$3,'obligation.deleted','obligation',$4)`,
        [randomUUID(), input.userId, input.actorSessionId, input.obligationId],
      );
    });
  }

  private async removeObjects(userId: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (!this.storage) throw new LifecycleStorageRequiredError();
    let pending = 0;
    for (const storageKey of keys) {
      try {
        await this.storage.remove(storageKey);
        await this.pool.query(
          "DELETE FROM lifecycle_object_cleanup WHERE storage_key = $1 AND user_id = $2",
          [storageKey, userId],
        );
      } catch (error) {
        pending += 1;
        await this.pool.query(
          `INSERT INTO lifecycle_object_cleanup(storage_key,user_id,attempts,last_error_code)
           VALUES ($1,$2,1,$3) ON CONFLICT (storage_key) DO UPDATE
           SET attempts = lifecycle_object_cleanup.attempts + 1, last_error_code = EXCLUDED.last_error_code`,
          [
            storageKey,
            userId,
            error instanceof Error ? error.name : "object_delete_failed",
          ],
        );
      }
    }
    return pending;
  }

  async exportUser(
    userId: string,
    includeOriginals = false,
  ): Promise<Record<string, unknown>> {
    const user = await this.pool.query<Record<string, unknown>>(
      "SELECT id, email_normalized, time_zone, created_at FROM users WHERE id = $1",
      [userId],
    );
    if (user.rowCount !== 1) throw new LifecycleNotFoundError();
    const [connections, obligations, evidence, blobs] = await Promise.all([
      this.pool.query(
        "SELECT id, provider, external_account_id, state, created_at FROM source_connections WHERE user_id = $1 ORDER BY created_at",
        [userId],
      ),
      this.pool.query(
        `SELECT o.id, o.state, v.revision, v.title, v.amount::text AS amount, v.currency, v.due_kind, v.due_date::text AS due_date, v.due_at, v.time_zone
        FROM obligations o LEFT JOIN obligation_versions v ON v.id = o.current_version_id WHERE o.user_id = $1 ORDER BY o.created_at`,
        [userId],
      ),
      this.pool.query(
        `SELECT e.id, e.kind, e.quote, e.page, item.external_id AS source_external_id
        FROM evidence e JOIN source_item_revisions r ON r.id=e.source_item_revision_id JOIN source_items item ON item.id=r.source_item_id
        WHERE e.user_id=$1 ORDER BY e.created_at`,
        [userId],
      ),
      includeOriginals
        ? this.pool.query(
            "SELECT id, storage_key, content_type FROM blobs WHERE user_id = $1 ORDER BY created_at",
            [userId],
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    const originals: Array<Record<string, unknown>> = [];
    if (includeOriginals) {
      if (!this.storage) throw new LifecycleStorageRequiredError();
      for (const blob of blobs.rows) {
        const bytes = await this.storage.get(String(blob.storage_key));
        if (bytes.byteLength > 10 * 1024 * 1024)
          throw new Error("Export original exceeds 10 MiB limit");
        originals.push({
          blobId: String(blob.id),
          contentType: String(blob.content_type),
          base64: Buffer.from(bytes).toString("base64"),
        });
      }
    }
    return {
      format: "crashmemory-export-v1",
      exportedAt: new Date().toISOString(),
      user: user.rows[0],
      connections: connections.rows,
      obligations: obligations.rows,
      evidence: evidence.rows,
      ...(includeOriginals ? { originals } : {}),
    };
  }
}
