import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { inTransaction, type Queryable } from "./client.ts";
import {
  fromStoredDue,
  normalizeMoney,
  toStoredDue,
  type StoredDueValue,
} from "@crashmemory/canonical-model";
import {
  OutboxEventSchema,
  TimeZoneSchema,
  type DueValue,
  type Money,
  type ObligationSummary,
  type OutboxEvent,
} from "@crashmemory/contracts";
import type { EncryptedSecret } from "@crashmemory/security";

export interface UserRecord {
  id: string;
  emailNormalized: string;
  passwordHash: string;
  timeZone: string;
  state: "active" | "disabled";
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    emailNormalized: String(row.email_normalized),
    passwordHash: String(row.password_hash),
    timeZone: String(row.time_zone),
    state: row.state as UserRecord["state"],
  };
}

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    emailNormalized: string;
    passwordHash: string;
    timeZone: string;
  }): Promise<UserRecord> {
    const timeZone = TimeZoneSchema.parse(input.timeZone);
    const result = await this.db.query(
      `INSERT INTO users(id, email_normalized, password_hash, time_zone)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.id, input.emailNormalized, input.passwordHash, timeZone],
    );
    return mapUser(result.rows[0] as Record<string, unknown>);
  }

  async findByEmail(emailNormalized: string): Promise<UserRecord | null> {
    const result = await this.db.query(
      "SELECT * FROM users WHERE email_normalized = $1 AND state = 'active'",
      [emailNormalized],
    );
    return result.rowCount === 0
      ? null
      : mapUser(result.rows[0] as Record<string, unknown>);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const result = await this.db.query(
      "SELECT * FROM users WHERE id = $1 AND state = 'active'",
      [id],
    );
    return result.rowCount === 0
      ? null
      : mapUser(result.rows[0] as Record<string, unknown>);
  }
}

export interface ActiveSession {
  id: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

export class SessionRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_sessions(id, user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.id,
        input.userId,
        input.tokenHash,
        input.csrfTokenHash,
        input.expiresAt,
      ],
    );
  }

  async findActive(
    tokenHash: string,
    now = new Date(),
  ): Promise<ActiveSession | null> {
    const result = await this.db.query(
      `SELECT s.id, s.user_id, s.csrf_token_hash, s.expires_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id AND u.state = 'active'
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [tokenHash, now],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      csrfTokenHash: String(row.csrf_token_hash),
      expiresAt: row.expires_at as Date,
    };
  }

  async revoke(id: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE auth_sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId],
    );
    return result.rowCount === 1;
  }
}

export class SourceRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Serializes a storage key across processes without holding a reversible
   * transaction over object-storage I/O. The same pool client owns lock and
   * unlock, so a failed writer can only compensate its own reservation before
   * a concurrent writer observes it.
   */
  async withBlobWriteLock<T>(
    blobId: string,
    operation: (catalog: SourceRepository) => Promise<T>,
  ): Promise<T> {
    const pool = this.db as Pool;
    if (typeof pool.connect !== "function") {
      throw new Error("Blob storage locks require a PostgreSQL pool");
    }
    const client = await pool.connect();
    let locked = false;
    let discardConnection = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        blobId,
      ]);
      locked = true;
      // DB reads and the insert run through this exact client. Holding a lock
      // does not consume a second pool slot or wrap object-storage I/O in a
      // reversible DB transaction.
      return await operation(new SourceRepository(client));
    } finally {
      if (locked) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [blobId],
          );
        } catch {
          discardConnection = true;
        }
      }
      client.release(discardConnection);
    }
  }

  async createConnection(input: {
    id: string;
    userId: string;
    externalAccountId: string;
    state?: "pending" | "active" | "revoked" | "error";
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO source_connections(id, user_id, provider, external_account_id, state)
       VALUES ($1, $2, 'gmail', $3, $4)`,
      [
        input.id,
        input.userId,
        input.externalAccountId,
        input.state ?? "pending",
      ],
    );
  }

  async storeCredential(input: {
    id: string;
    userId: string;
    sourceConnectionId: string;
    encrypted: EncryptedSecret;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO encrypted_credentials(
         id, user_id, source_connection_id, key_version, iv, ciphertext, auth_tag
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_connection_id) DO UPDATE
       SET key_version = EXCLUDED.key_version, iv = EXCLUDED.iv,
           ciphertext = EXCLUDED.ciphertext, auth_tag = EXCLUDED.auth_tag,
           updated_at = now()
       WHERE encrypted_credentials.user_id = EXCLUDED.user_id`,
      [
        input.id,
        input.userId,
        input.sourceConnectionId,
        input.encrypted.keyVersion,
        Buffer.from(input.encrypted.iv, "base64"),
        Buffer.from(input.encrypted.ciphertext, "base64"),
        Buffer.from(input.encrypted.authTag, "base64"),
      ],
    );
  }

  async findConnectionByExternalAccount(
    userId: string,
    externalAccountId: string,
  ): Promise<{ id: string; state: string } | null> {
    const result = await this.db.query(
      `SELECT id, state FROM source_connections
       WHERE user_id = $1 AND provider = 'gmail' AND external_account_id = $2`,
      [userId, externalAccountId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return { id: String(row.id), state: String(row.state) };
  }

  async markConnectionAuthorized(
    userId: string,
    connectionId: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE source_connections
       SET state = 'active', oauth_authorized_at = now(), last_sync_error_code = NULL,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [connectionId, userId],
    );
  }

  async listConnections(
    userId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query(
      `SELECT id, external_account_id, state, oauth_authorized_at,
              watch_expiration_at, last_sync_at, last_sync_error_code
       FROM source_connections WHERE user_id = $1 AND provider = 'gmail'
       ORDER BY created_at`,
      [userId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * Pub/Sub carries only a wake-up historyId. This stores the wake-up durably
   * but never updates sync_cursors: the sync must persist its catch-up first.
   */
  async recordGmailPushNotification(
    externalAccountId: string,
    historyId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO gmail_push_notifications(
         source_connection_id, user_id, notification_history_id, received_at
       )
       SELECT id, user_id, $2, now()
       FROM source_connections
       WHERE provider = 'gmail' AND external_account_id = $1 AND state = 'active'
       ON CONFLICT (source_connection_id) DO UPDATE
       SET notification_history_id = EXCLUDED.notification_history_id,
           received_at = EXCLUDED.received_at`,
      [externalAccountId, historyId],
    );
  }

  async listActiveGmailConnections(): Promise<
    Array<{
      id: string;
      userId: string;
      cursorValue: string | null;
      watchExpirationAt: Date | null;
      hasWakeup: boolean;
    }>
  > {
    const result = await this.db.query(
      `SELECT c.id, c.user_id, cursor.cursor_value, c.watch_expiration_at,
              notification.source_connection_id IS NOT NULL AS has_wakeup
       FROM source_connections c
       LEFT JOIN sync_cursors cursor ON cursor.source_connection_id = c.id
       LEFT JOIN gmail_push_notifications notification ON notification.source_connection_id = c.id
       WHERE c.provider = 'gmail' AND c.state = 'active'
       ORDER BY c.created_at`,
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      userId: String(row.user_id),
      cursorValue: row.cursor_value === null ? null : String(row.cursor_value),
      watchExpirationAt: (row.watch_expiration_at as Date | null) ?? null,
      hasWakeup: row.has_wakeup === true,
    }));
  }

  async clearGmailPushNotification(connectionId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM gmail_push_notifications WHERE source_connection_id = $1",
      [connectionId],
    );
  }

  async getCredential(
    userId: string,
    sourceConnectionId: string,
  ): Promise<EncryptedSecret | null> {
    const result = await this.db.query(
      `SELECT key_version, iv, ciphertext, auth_tag
       FROM encrypted_credentials
       WHERE user_id = $1 AND source_connection_id = $2`,
      [userId, sourceConnectionId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      keyVersion: String(row.key_version),
      iv: (row.iv as Buffer).toString("base64"),
      ciphertext: (row.ciphertext as Buffer).toString("base64"),
      authTag: (row.auth_tag as Buffer).toString("base64"),
    };
  }

  async createBlob(input: {
    id: string;
    userId: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    contentSha256: string;
  }): Promise<void> {
    if (!input.storageKey.startsWith(`users/${input.userId}/`)) {
      throw new Error("Blob storage keys must be namespaced by owner");
    }
    await this.db.query(
      `INSERT INTO blobs(id, user_id, storage_key, content_type, byte_size, content_sha256)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.userId,
        input.storageKey,
        input.contentType,
        input.byteSize,
        input.contentSha256,
      ],
    );
  }

  async getBlob(
    userId: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db.query(
      `SELECT id, storage_key, content_type, byte_size, content_sha256
       FROM blobs WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return result.rowCount === 0
      ? null
      : (result.rows[0] as Record<string, unknown>);
  }

  async createItem(input: {
    id: string;
    userId: string;
    sourceConnectionId: string;
    externalId: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO source_items(id, user_id, source_connection_id, external_id)
       VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.sourceConnectionId, input.externalId],
    );
  }

  async createRevision(input: {
    id: string;
    userId: string;
    sourceItemId: string;
    revision: number;
    originalBlobId: string;
    contentSha256: string;
    observedAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO source_item_revisions(
         id, user_id, source_item_id, revision, original_blob_id, content_sha256, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.userId,
        input.sourceItemId,
        input.revision,
        input.originalBlobId,
        input.contentSha256,
        input.observedAt,
      ],
    );
  }

  async createNormalizedBody(input: {
    id: string;
    userId: string;
    sourceItemRevisionId: string;
    bodyBlobId: string;
    contentSha256: string;
    utf16Length: number;
    normalizationVersion: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO source_revision_bodies(
         id, user_id, source_item_revision_id, body_blob_id, content_sha256,
         utf16_length, normalization_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.userId,
        input.sourceItemRevisionId,
        input.bodyBlobId,
        input.contentSha256,
        input.utf16Length,
        input.normalizationVersion,
      ],
    );
  }

  async createAttachment(input: {
    id: string;
    userId: string;
    sourceItemRevisionId: string;
    externalAttachmentId: string;
    blobId: string;
    fileName: string;
    mediaType: string;
    byteSize: number;
    contentSha256: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO source_attachments(
         id, user_id, source_item_revision_id, external_attachment_id, blob_id,
         file_name, media_type, byte_size, content_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.userId,
        input.sourceItemRevisionId,
        input.externalAttachmentId,
        input.blobId,
        input.fileName,
        input.mediaType,
        input.byteSize,
        input.contentSha256,
      ],
    );
  }

  async getExtractionInput(
    userId: string,
    sourceItemRevisionId: string,
  ): Promise<{
    sourceItemRevisionId: string;
    body: {
      blobId: string;
      contentSha256: string;
      utf16Length: number;
      normalizationVersion: string;
    };
    attachments: Array<{
      id: string;
      blobId: string;
      fileName: string;
      mediaType: string;
      byteSize: number;
      contentSha256: string;
    }>;
  } | null> {
    const bodyResult = await this.db.query(
      `SELECT source_item_revision_id, body_blob_id, content_sha256,
              utf16_length, normalization_version
       FROM source_revision_bodies
       WHERE source_item_revision_id = $1 AND user_id = $2`,
      [sourceItemRevisionId, userId],
    );
    if (bodyResult.rowCount === 0) return null;
    const body = bodyResult.rows[0] as Record<string, unknown>;
    const attachments = await this.db.query(
      `SELECT id, blob_id, file_name, media_type, byte_size, content_sha256
       FROM source_attachments
       WHERE source_item_revision_id = $1 AND user_id = $2
       ORDER BY external_attachment_id`,
      [sourceItemRevisionId, userId],
    );
    return {
      sourceItemRevisionId: String(body.source_item_revision_id),
      body: {
        blobId: String(body.body_blob_id),
        contentSha256: String(body.content_sha256),
        utf16Length: Number(body.utf16_length),
        normalizationVersion: String(body.normalization_version),
      },
      attachments: attachments.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        blobId: String(row.blob_id),
        fileName: String(row.file_name),
        mediaType: String(row.media_type),
        byteSize: Number(row.byte_size),
        contentSha256: String(row.content_sha256),
      })),
    };
  }

  async createEvidence(input: {
    id: string;
    userId: string;
    sourceItemRevisionId: string;
    kind: "email_body_fragment" | "pdf_text_fragment";
    attachmentId?: string;
    page?: number;
    startOffset: number;
    endOffset: number;
    quote: string;
    contentSha256: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO evidence(
         id, user_id, source_item_revision_id, kind, attachment_id, page,
         start_offset, end_offset, quote, content_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.id,
        input.userId,
        input.sourceItemRevisionId,
        input.kind,
        input.attachmentId ?? null,
        input.page ?? null,
        input.startOffset,
        input.endOffset,
        input.quote,
        input.contentSha256,
      ],
    );
  }

  async getEvidence(
    userId: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db.query(
      `SELECT e.id, e.kind, e.source_item_revision_id, e.attachment_id,
              e.page, e.start_offset, e.end_offset, e.quote, e.content_sha256,
              r.original_blob_id
       FROM evidence e
       JOIN source_item_revisions r
         ON r.id = e.source_item_revision_id AND r.user_id = e.user_id
       WHERE e.id = $1 AND e.user_id = $2`,
      [id, userId],
    );
    return result.rowCount === 0
      ? null
      : (result.rows[0] as Record<string, unknown>);
  }
}

function canonicalNumeric(value: string | null): string | undefined {
  if (value === null) return undefined;
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
}

export class ObligationRepository {
  constructor(private readonly pool: Pool) {}

  async createCandidate(input: {
    id: string;
    versionId: string;
    userId: string;
    title: string;
    amount?: Money;
    due?: DueValue;
    evidenceIds: string[];
    outboxEvent: OutboxEvent;
  }): Promise<void> {
    const uniqueEvidenceIds = [...new Set(input.evidenceIds)];
    if (
      uniqueEvidenceIds.length === 0 ||
      uniqueEvidenceIds.length !== input.evidenceIds.length
    ) {
      throw new Error(
        "A candidate requires at least one unique evidence record",
      );
    }
    const amount = normalizeMoney(input.amount);
    const due = toStoredDue(input.due);
    const event = OutboxEventSchema.parse(input.outboxEvent);
    if (
      event.userId !== input.userId ||
      event.aggregateId !== input.id ||
      event.type !== "obligation.candidate.created.v1" ||
      event.payload.obligationId !== input.id
    ) {
      throw new Error(
        "Outbox event does not belong to the candidate obligation",
      );
    }
    await inTransaction(this.pool, async (client) => {
      const evidence = await client.query<{ matched: number }>(
        `SELECT count(*)::integer AS matched
         FROM evidence
         WHERE user_id = $1 AND source_item_revision_id = $2
           AND id = ANY($3::uuid[])`,
        [input.userId, event.payload.sourceItemRevisionId, uniqueEvidenceIds],
      );
      if (evidence.rows[0]?.matched !== uniqueEvidenceIds.length) {
        throw new Error(
          "Candidate evidence must belong to its user and source revision",
        );
      }
      await client.query(
        "INSERT INTO obligations(id, user_id, state) VALUES ($1, $2, 'candidate')",
        [input.id, input.userId],
      );
      await client.query(
        `INSERT INTO obligation_versions(
           id, user_id, obligation_id, revision, title, amount, currency,
           due_kind, due_date, due_at, time_zone
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.versionId,
          input.userId,
          input.id,
          input.title,
          amount?.amount ?? null,
          amount?.currency ?? null,
          due.dueKind,
          due.dueDate,
          due.dueAt,
          due.timeZone,
        ],
      );
      for (const evidenceId of uniqueEvidenceIds) {
        await client.query(
          `INSERT INTO obligation_version_evidence(user_id, obligation_version_id, evidence_id)
           VALUES ($1, $2, $3)`,
          [input.userId, input.versionId, evidenceId],
        );
      }
      await client.query(
        "UPDATE obligations SET current_version_id = $1, updated_at = now() WHERE id = $2 AND user_id = $3",
        [input.versionId, input.id, input.userId],
      );
      await client.query(
        `INSERT INTO outbox_events(
           id, user_id, event_type, aggregate_type, aggregate_id,
           idempotency_key, occurred_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.id,
          event.userId,
          event.type,
          event.aggregateType,
          event.aggregateId,
          event.idempotencyKey,
          event.occurredAt,
          event.payload,
        ],
      );
    });
  }

  async getSummary(
    userId: string,
    id: string,
  ): Promise<ObligationSummary | null> {
    const result = await this.pool.query(
      `SELECT o.id, o.state, o.current_version_id, v.title, v.amount::text AS amount,
              v.currency, v.due_kind, v.due_date::text AS due_date,
              v.due_at, v.time_zone, v.revision,
              COALESCE(array_agg(ove.evidence_id::text) FILTER (WHERE ove.evidence_id IS NOT NULL), '{}') AS evidence_ids
       FROM obligations o
       JOIN obligation_versions v
         ON v.id = o.current_version_id AND v.user_id = o.user_id AND v.obligation_id = o.id
       LEFT JOIN obligation_version_evidence ove
         ON ove.obligation_version_id = v.id AND ove.user_id = o.user_id
       WHERE o.id = $1 AND o.user_id = $2
       GROUP BY o.id, o.state, o.current_version_id, v.title, v.amount, v.currency,
                v.due_kind, v.due_date, v.due_at, v.time_zone, v.revision`,
      [id, userId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    const amount = canonicalNumeric(row.amount as string | null);
    const storedDue: StoredDueValue = {
      dueKind: row.due_kind as StoredDueValue["dueKind"],
      dueDate: row.due_date as string | null,
      dueAt: row.due_at ? (row.due_at as Date).toISOString() : null,
      timeZone: row.time_zone as string | null,
    };
    return {
      id: String(row.id),
      currentVersionId: String(row.current_version_id),
      state: row.state as ObligationSummary["state"],
      title: String(row.title),
      ...(amount && row.currency
        ? { amount: { amount, currency: String(row.currency).trim() } }
        : {}),
      ...(storedDue.dueKind ? { due: fromStoredDue(storedDue) } : {}),
      evidenceIds: row.evidence_ids as string[],
      revision: Number(row.revision),
    };
  }

  async addCorrection(input: {
    id: string;
    userId: string;
    obligationId: string;
    basedOnVersionId: string;
    fieldName: "title" | "amount" | "due" | "state";
    correctedValue: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO field_corrections(
         id, user_id, obligation_id, based_on_version_id, field_name, corrected_value
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.userId,
        input.obligationId,
        input.basedOnVersionId,
        input.fieldName,
        input.correctedValue,
      ],
    );
  }
}

export class CursorRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    id: string;
    userId: string;
    sourceConnectionId: string;
    cursorValue: string;
    observedAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_cursors(id, user_id, source_connection_id, cursor_value, observed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_connection_id) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value,
           observed_at = EXCLUDED.observed_at,
           updated_at = now()
       WHERE sync_cursors.user_id = EXCLUDED.user_id`,
      [
        input.id,
        input.userId,
        input.sourceConnectionId,
        input.cursorValue,
        input.observedAt,
      ],
    );
  }

  async get(
    userId: string,
    sourceConnectionId: string,
  ): Promise<string | null> {
    const result = await this.db.query(
      `SELECT cursor_value FROM sync_cursors
       WHERE user_id = $1 AND source_connection_id = $2`,
      [userId, sourceConnectionId],
    );
    return result.rowCount === 0 ? null : String(result.rows[0]?.cursor_value);
  }
}

export class OAuthCallbackRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    userId: string;
    authSessionId: string;
    provider: "gmail";
    nonceHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_callback_nonces(
         id, user_id, auth_session_id, provider, nonce_hash, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.userId,
        input.authSessionId,
        input.provider,
        input.nonceHash,
        input.expiresAt,
      ],
    );
  }

  async consume(input: {
    userId: string;
    authSessionId: string;
    provider: "gmail";
    nonceHash: string;
    now?: Date;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE oauth_callback_nonces
       SET consumed_at = $5
       WHERE user_id = $1 AND auth_session_id = $2 AND provider = $3
         AND nonce_hash = $4 AND consumed_at IS NULL AND expires_at > $5`,
      [
        input.userId,
        input.authSessionId,
        input.provider,
        input.nonceHash,
        input.now ?? new Date(),
      ],
    );
    return result.rowCount === 1;
  }
}

export class ReminderRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    userId: string;
    obligationId: string;
    obligationVersionId: string;
    targetVersion: number;
    scheduledFor: Date;
    policy: unknown;
    dedupeKey: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO reminders(
         id, user_id, obligation_id, obligation_version_id, target_version,
         scheduled_for, policy, dedupe_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [
        input.id,
        input.userId,
        input.obligationId,
        input.obligationVersionId,
        input.targetVersion,
        input.scheduledFor,
        JSON.stringify(input.policy),
        input.dedupeKey,
      ],
    );
  }

  async recordAttempt(input: {
    id: string;
    userId: string;
    reminderId: string;
    attemptNumber: number;
    outcome: "sent" | "failed" | "unknown";
    providerMessageId?: string;
    errorCode?: string;
    resolvedAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO delivery_attempts(
         id, user_id, reminder_id, attempt_number, outcome,
         provider_message_id, error_code, resolved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        input.userId,
        input.reminderId,
        input.attemptNumber,
        input.outcome,
        input.providerMessageId ?? null,
        input.errorCode ?? null,
        input.resolvedAt,
      ],
    );
  }
}

export interface TelegramRecipientRecord {
  id: string;
  userId: string;
  encryptedChatId: EncryptedSecret;
}

export interface DeliveryAttemptRecord {
  id: string;
  userId: string;
  reminderId: string;
  attemptNumber: number;
  state: "prepared" | "resolved";
  outcome: "sent" | "failed" | "unknown" | null;
}

export interface ReminderStatusRecord {
  id: string;
  obligationId: string;
  obligationVersionId: string;
  targetVersion: number;
  state: "scheduled" | "cancelled" | "delivering" | "resolved";
  scheduledFor: string;
}

export interface DeliveryAttemptStatusRecord {
  id: string;
  reminderId: string;
  attemptNumber: number;
  state: "prepared" | "resolved";
  outcome: "sent" | "failed" | "unknown" | null;
  preparedAt: string;
  resolvedAt: string | null;
}

/** Durable persistence for bot linking and the external-delivery boundary. */
export class NotificationRepository {
  constructor(private readonly db: Queryable) {}

  async createLinkChallenge(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_link_challenges(id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt],
    );
  }

  async registerTelegramUpdate(input: {
    botKey: string;
    updateId: number;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO telegram_inbound_updates(bot_key, update_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [input.botKey, input.updateId],
    );
    return result.rowCount === 1;
  }

  async setPollOffset(botKey: string, nextUpdateId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_poll_offsets(bot_key, next_update_id)
       VALUES ($1, $2)
       ON CONFLICT (bot_key) DO UPDATE
       SET next_update_id = GREATEST(telegram_poll_offsets.next_update_id, EXCLUDED.next_update_id),
           updated_at = now()`,
      [botKey, nextUpdateId],
    );
  }

  async getPollOffset(botKey: string): Promise<number | null> {
    const result = await this.db.query<{ next_update_id: string }>(
      "SELECT next_update_id FROM telegram_poll_offsets WHERE bot_key = $1",
      [botKey],
    );
    return result.rowCount === 0
      ? null
      : Number(result.rows[0]?.next_update_id);
  }

  async consumeChallengeAndSetRecipient(input: {
    challengeTokenHash: string;
    recipient: TelegramRecipientRecord;
    now?: Date;
  }): Promise<"linked" | "ignored"> {
    const now = input.now ?? new Date();
    const challenge = await this.db.query<Record<string, unknown>>(
      `UPDATE telegram_link_challenges SET consumed_at = $2
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING id, user_id`,
      [input.challengeTokenHash, now],
    );
    if (challenge.rowCount !== 1) return "ignored";
    const userId = String(challenge.rows[0]?.user_id);
    if (userId !== input.recipient.userId) {
      throw new Error("Telegram recipient owner does not match link challenge");
    }
    await this.db.query(
      `INSERT INTO telegram_recipients(
         id, user_id, key_version, iv, ciphertext, auth_tag, state
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (user_id) DO UPDATE
       SET id = EXCLUDED.id, key_version = EXCLUDED.key_version, iv = EXCLUDED.iv,
           ciphertext = EXCLUDED.ciphertext, auth_tag = EXCLUDED.auth_tag,
           state = 'active', linked_at = now(), revoked_at = NULL`,
      [
        input.recipient.id,
        input.recipient.userId,
        input.recipient.encryptedChatId.keyVersion,
        Buffer.from(input.recipient.encryptedChatId.iv, "base64"),
        Buffer.from(input.recipient.encryptedChatId.ciphertext, "base64"),
        Buffer.from(input.recipient.encryptedChatId.authTag, "base64"),
      ],
    );
    return "linked";
  }

  async activeRecipient(
    userId: string,
  ): Promise<TelegramRecipientRecord | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, user_id, key_version, iv, ciphertext, auth_tag
       FROM telegram_recipients WHERE user_id = $1 AND state = 'active'`,
      [userId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] ?? {};
    return {
      id: String(row.id),
      userId: String(row.user_id),
      encryptedChatId: {
        keyVersion: String(row.key_version),
        iv: (row.iv as Buffer).toString("base64"),
        ciphertext: (row.ciphertext as Buffer).toString("base64"),
        authTag: (row.auth_tag as Buffer).toString("base64"),
      },
    };
  }

  async linkStatus(
    userId: string,
  ): Promise<{ linked: boolean; linkedAt: string | null }> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT linked_at::text AS linked_at FROM telegram_recipients
       WHERE user_id = $1 AND state = 'active'`,
      [userId],
    );
    return result.rowCount === 1
      ? { linked: true, linkedAt: String(result.rows[0]?.linked_at) }
      : { linked: false, linkedAt: null };
  }

  async listReminders(input: {
    userId: string;
    limit: number;
    cursor?: { scheduledFor: string; id: string };
  }): Promise<ReminderStatusRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, obligation_id, obligation_version_id, target_version, state,
              scheduled_for::text AS scheduled_for
       FROM reminders
       WHERE user_id = $1
         AND ($2::timestamptz IS NULL OR (scheduled_for, id) > ($2::timestamptz, $3::uuid))
       ORDER BY scheduled_for, id LIMIT $4`,
      [
        input.userId,
        input.cursor?.scheduledFor ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      obligationId: String(row.obligation_id),
      obligationVersionId: String(row.obligation_version_id),
      targetVersion: Number(row.target_version),
      state: row.state as ReminderStatusRecord["state"],
      scheduledFor: String(row.scheduled_for),
    }));
  }

  async listDeliveryAttempts(input: {
    userId: string;
    reminderId: string;
    limit: number;
    cursor?: { preparedAt: string; id: string };
  }): Promise<DeliveryAttemptStatusRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT a.id, a.reminder_id, a.attempt_number, a.prepared_at::text AS prepared_at,
              r.outcome, r.resolved_at::text AS resolved_at
       FROM notification_delivery_attempts a
       LEFT JOIN notification_delivery_resolutions r ON r.attempt_id = a.id
       WHERE a.user_id = $1 AND a.reminder_id = $2
         AND ($3::timestamptz IS NULL OR (a.prepared_at, a.id) > ($3::timestamptz, $4::uuid))
       ORDER BY a.prepared_at, a.id LIMIT $5`,
      [
        input.userId,
        input.reminderId,
        input.cursor?.preparedAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      reminderId: String(row.reminder_id),
      attemptNumber: Number(row.attempt_number),
      state: row.outcome === null ? "prepared" : "resolved",
      outcome: (row.outcome as DeliveryAttemptStatusRecord["outcome"]) ?? null,
      preparedAt: String(row.prepared_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    }));
  }

  async isDeliveryCurrent(input: {
    reminderId: string;
    userId: string;
    targetVersion: number;
  }): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM reminders r
       JOIN obligations o ON o.id = r.obligation_id AND o.user_id = r.user_id
       WHERE r.id = $1 AND r.user_id = $2 AND r.target_version = $3
         AND r.state = 'delivering' AND o.state = 'confirmed'`,
      [input.reminderId, input.userId, input.targetVersion],
    );
    return result.rowCount === 1;
  }

  async prepareDelivery(input: {
    id: string;
    reminderId: string;
    userId: string;
    targetVersion: number;
  }): Promise<
    | { state: "ready"; attempt: DeliveryAttemptRecord }
    | { state: "already_resolved" | "unknown" | "cancelled" }
  > {
    const reminder = await this.db.query<Record<string, unknown>>(
      `SELECT id, user_id, state, target_version
       FROM reminders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [input.reminderId, input.userId],
    );
    if (reminder.rowCount !== 1) return { state: "cancelled" };
    const row = reminder.rows[0] ?? {};
    if (
      Number(row.target_version) !== input.targetVersion ||
      row.state === "cancelled"
    ) {
      return { state: "cancelled" };
    }
    const prior = await this.db.query<Record<string, unknown>>(
      `SELECT a.id, a.user_id, a.reminder_id, a.attempt_number, r.outcome
       FROM notification_delivery_attempts a
       LEFT JOIN notification_delivery_resolutions r ON r.attempt_id = a.id
       WHERE a.reminder_id = $1
       ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE OF a`,
      [input.reminderId],
    );
    const priorRow = prior.rows[0];
    if (priorRow && priorRow.outcome === null) {
      await this.db.query(
        `INSERT INTO notification_delivery_resolutions(id, user_id, attempt_id, outcome, error_code)
         VALUES ($1, $2, $3, 'unknown', 'interrupted_after_prepare')
         ON CONFLICT (attempt_id) DO NOTHING`,
        [randomUUID(), input.userId, priorRow.id],
      );
      await this.db.query(
        `UPDATE reminders SET state = 'resolved', updated_at = now() WHERE id = $1`,
        [input.reminderId],
      );
      return { state: "unknown" };
    }
    if (priorRow?.outcome === "sent" || priorRow?.outcome === "unknown") {
      return { state: "already_resolved" };
    }
    const attemptNumber = Number(priorRow?.attempt_number ?? 0) + 1;
    await this.db.query(
      `INSERT INTO notification_delivery_attempts(id, user_id, reminder_id, attempt_number)
       VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.reminderId, attemptNumber],
    );
    await this.db.query(
      `UPDATE reminders SET state = 'delivering', updated_at = now() WHERE id = $1`,
      [input.reminderId],
    );
    return {
      state: "ready",
      attempt: {
        id: input.id,
        userId: input.userId,
        reminderId: input.reminderId,
        attemptNumber,
        state: "prepared",
        outcome: null,
      },
    };
  }

  async resolveDelivery(input: {
    attemptId: string;
    outcome: "sent" | "failed" | "unknown";
    providerMessageId?: string;
    errorCode?: string;
  }): Promise<{ reminderId: string; userId: string } | null> {
    const attempt = await this.db.query<Record<string, unknown>>(
      `INSERT INTO notification_delivery_resolutions(
         id, user_id, attempt_id, outcome, provider_message_id, error_code
       ) SELECT $1, a.user_id, a.id, $2, $3, $4
         FROM notification_delivery_attempts a
         LEFT JOIN notification_delivery_resolutions r ON r.attempt_id = a.id
         WHERE a.id = $5 AND r.attempt_id IS NULL
       RETURNING attempt_id`,
      [
        randomUUID(),
        input.outcome,
        input.providerMessageId ?? null,
        input.errorCode ?? null,
        input.attemptId,
      ],
    );
    if (attempt.rowCount !== 1) return null;
    const row = await this.db.query<Record<string, unknown>>(
      "SELECT reminder_id, user_id FROM notification_delivery_attempts WHERE id = $1",
      [input.attemptId],
    );
    const attemptRow = row.rows[0] ?? {};
    await this.db.query(
      `UPDATE reminders SET state = 'resolved', updated_at = now()
       WHERE id = $1 AND state = 'delivering'`,
      [attemptRow.reminder_id],
    );
    return {
      reminderId: String(attemptRow.reminder_id),
      userId: String(attemptRow.user_id),
    };
  }

  async cancelForObligation(
    userId: string,
    obligationId: string,
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE reminders SET state = 'cancelled', updated_at = now()
       WHERE user_id = $1 AND obligation_id = $2 AND state IN ('scheduled', 'delivering')`,
      [userId, obligationId],
    );
    return result.rowCount ?? 0;
  }

  async cancelObsoleteForObligation(
    userId: string,
    obligationId: string,
    currentVersionId: string,
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE reminders SET state = 'cancelled', updated_at = now()
       WHERE user_id = $1 AND obligation_id = $2 AND obligation_version_id <> $3
         AND state IN ('scheduled', 'delivering')`,
      [userId, obligationId, currentVersionId],
    );
    return result.rowCount ?? 0;
  }
}

export class LedgerRepository {
  constructor(private readonly db: Queryable) {}

  async recordModelUsage(input: {
    id: string;
    userId: string;
    operationKey: string;
    entrySequence: number;
    provider: string;
    model: string;
    pricingVersion: string;
    status: "reserved" | "estimated" | "billed" | "unknown" | "released";
    inputUnits?: number;
    outputUnits?: number;
    cost?: Money;
  }): Promise<void> {
    const cost = input.cost ? normalizeMoney(input.cost) : undefined;
    await this.db.query(
      `INSERT INTO model_usage_ledger(
         id, user_id, operation_key, entry_sequence, provider, model, pricing_version, status,
         input_units, output_units, cost_amount, cost_currency
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.id,
        input.userId,
        input.operationKey,
        input.entrySequence,
        input.provider,
        input.model,
        input.pricingVersion,
        input.status,
        input.inputUnits ?? null,
        input.outputUnits ?? null,
        cost?.amount ?? null,
        cost?.currency ?? null,
      ],
    );
  }

  async appendAudit(input: {
    id: string;
    userId: string;
    actorSessionId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_ledger_entries(
         id, user_id, actor_session_id, action, target_type, target_id, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.userId,
        input.actorSessionId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.details ?? {},
      ],
    );
  }
}

export interface ModelBudgetReservation {
  id: string;
  operationKey: string;
  attemptNumber: number;
  reservedAmount: string;
}

/**
 * Keeps the mutable budget guard separate from the immutable usage ledger.
 * A reservation is held before a remote request and an unknown timeout keeps
 * its maximum cost reserved instead of being treated as a free failure.
 */
export class ModelBudgetRepository {
  constructor(private readonly pool: Pool) {}

  async setLimit(input: {
    id: string;
    userId: string;
    limitAmountUsd: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_budget_limits(
         id, user_id, currency, limit_amount, period_start, period_end
       ) VALUES ($1, $2, 'USD', $3, $4, $5)`,
      [
        input.id,
        input.userId,
        input.limitAmountUsd,
        input.periodStart,
        input.periodEnd,
      ],
    );
  }

  async reserve(input: {
    id: string;
    userId: string;
    operationKey: string;
    attemptNumber: number;
    maximumCostUsd: string;
    provider: string;
    model: string;
    pricingVersion: string;
    maximumInputUnits: number;
    maximumOutputUnits: number;
    now?: Date;
  }): Promise<ModelBudgetReservation> {
    const now = input.now ?? new Date();
    return inTransaction(this.pool, async (client) => {
      const limit = await client.query<Record<string, unknown>>(
        `SELECT id, limit_amount
         FROM model_budget_limits
         WHERE user_id = $1 AND currency = 'USD'
           AND period_start <= $2 AND period_end > $2
         FOR UPDATE`,
        [input.userId, now],
      );
      const row = limit.rows[0];
      if (!row) throw new Error("No active USD model budget is configured");

      const used = await client.query<{ amount: string }>(
        `SELECT COALESCE(sum(
           CASE WHEN state = 'settled' THEN settled_amount ELSE reserved_amount END
         ), 0)::text AS amount
         FROM model_budget_reservations
         WHERE budget_limit_id = $1
           AND state IN ('reserved', 'settled', 'unknown')`,
        [row.id],
      );
      const available = await client.query<{ permitted: boolean }>(
        `SELECT ($1::numeric + $2::numeric) <= $3::numeric AS permitted`,
        [
          used.rows[0]?.amount ?? "0",
          input.maximumCostUsd,
          String(row.limit_amount),
        ],
      );
      if (!available.rows[0]?.permitted) {
        throw new Error("Model budget would be exceeded");
      }

      await client.query(
        `INSERT INTO model_budget_reservations(
           id, user_id, budget_limit_id, operation_key, attempt_number,
           reserved_amount, state
         ) VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`,
        [
          input.id,
          input.userId,
          row.id,
          input.operationKey,
          input.attemptNumber,
          input.maximumCostUsd,
        ],
      );
      await this.appendUsage(client, {
        id: randomUUID(),
        userId: input.userId,
        operationKey: input.operationKey,
        entrySequence: input.attemptNumber * 10 + 1,
        provider: input.provider,
        model: input.model,
        pricingVersion: input.pricingVersion,
        status: "reserved",
        inputUnits: input.maximumInputUnits,
        outputUnits: input.maximumOutputUnits,
        costUsd: input.maximumCostUsd,
      });
      return {
        id: input.id,
        operationKey: input.operationKey,
        attemptNumber: input.attemptNumber,
        reservedAmount: input.maximumCostUsd,
      };
    });
  }

  async settle(input: {
    reservationId: string;
    userId: string;
    actualCostUsd: string;
    inputUnits: number;
    outputUnits: number;
    provider: string;
    model: string;
    pricingVersion: string;
    now?: Date;
  }): Promise<void> {
    await this.finish(input, "estimated");
  }

  async markUnknown(input: {
    reservationId: string;
    userId: string;
    provider: string;
    model: string;
    pricingVersion: string;
    now?: Date;
  }): Promise<void> {
    await this.finish(input, "unknown");
  }

  private async finish(
    input: {
      reservationId: string;
      userId: string;
      provider: string;
      model: string;
      pricingVersion: string;
      now?: Date;
      actualCostUsd?: string;
      inputUnits?: number;
      outputUnits?: number;
    },
    status: "estimated" | "unknown",
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const reservation = await client.query<Record<string, unknown>>(
        `SELECT operation_key, attempt_number, reserved_amount, state
         FROM model_budget_reservations
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.reservationId, input.userId],
      );
      const row = reservation.rows[0];
      if (!row) throw new Error("Model budget reservation was not found");
      if (row.state !== "reserved") return;
      if (status === "estimated" && !input.actualCostUsd) {
        throw new Error(
          "An estimated model cost is required to settle a reservation",
        );
      }
      const cost =
        status === "estimated"
          ? input.actualCostUsd!
          : String(row.reserved_amount);
      await client.query(
        `UPDATE model_budget_reservations
         SET state = $3, settled_amount = CASE WHEN $3 = 'settled' THEN $4::numeric END,
             settled_at = $5
         WHERE id = $1 AND user_id = $2`,
        [
          input.reservationId,
          input.userId,
          status === "estimated" ? "settled" : "unknown",
          cost,
          input.now ?? new Date(),
        ],
      );
      await this.appendUsage(client, {
        id: randomUUID(),
        userId: input.userId,
        operationKey: String(row.operation_key),
        entrySequence: Number(row.attempt_number) * 10 + 2,
        provider: input.provider,
        model: input.model,
        pricingVersion: input.pricingVersion,
        status,
        inputUnits: input.inputUnits,
        outputUnits: input.outputUnits,
        costUsd: cost,
      });
    });
  }

  private async appendUsage(
    db: Queryable,
    input: {
      id: string;
      userId: string;
      operationKey: string;
      entrySequence: number;
      provider: string;
      model: string;
      pricingVersion: string;
      status: "reserved" | "estimated" | "unknown";
      inputUnits?: number;
      outputUnits?: number;
      costUsd: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO model_usage_ledger(
         id, user_id, operation_key, entry_sequence, provider, model, pricing_version,
         status, input_units, output_units, cost_amount, cost_currency
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'USD')`,
      [
        input.id,
        input.userId,
        input.operationKey,
        input.entrySequence,
        input.provider,
        input.model,
        input.pricingVersion,
        input.status,
        input.inputUnits ?? null,
        input.outputUnits ?? null,
        input.costUsd,
      ],
    );
  }
}

export class ExtractionRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    id: string;
    userId: string;
    sourceItemRevisionId: string;
    privacyProfile: "local-only" | "remote-allowed";
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO extraction_jobs(id, user_id, source_item_revision_id, privacy_profile, state)
       VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (user_id, source_item_revision_id) DO NOTHING`,
      [
        input.id,
        input.userId,
        input.sourceItemRevisionId,
        input.privacyProfile,
      ],
    );
  }

  async savePdfPages(input: {
    userId: string;
    sourceItemRevisionId: string;
    pages: Array<{
      attachmentId: string;
      page: number;
      text: string;
      contentSha256: string;
    }>;
  }): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      for (const page of input.pages) {
        await client.query(
          `INSERT INTO extraction_pdf_pages(id, user_id, source_item_revision_id, attachment_id, page, extracted_text, content_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (attachment_id, page) DO NOTHING`,
          [
            randomUUID(),
            input.userId,
            input.sourceItemRevisionId,
            page.attachmentId,
            page.page,
            page.text,
            page.contentSha256,
          ],
        );
      }
    });
  }

  async claimNext(): Promise<{
    id: string;
    userId: string;
    sourceItemRevisionId: string;
    privacyProfile: "local-only" | "remote-allowed";
    attemptNumber: number;
  } | null> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `WITH next AS (SELECT id FROM extraction_jobs WHERE state = 'pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE extraction_jobs j SET state = 'running', attempts = attempts + 1, claimed_at = now() FROM next WHERE j.id = next.id
         RETURNING j.id, j.user_id, j.source_item_revision_id, j.privacy_profile, j.attempts`,
      );
      const row = result.rows[0];
      return row
        ? {
            id: String(row.id),
            userId: String(row.user_id),
            sourceItemRevisionId: String(row.source_item_revision_id),
            privacyProfile: row.privacy_profile as
              "local-only" | "remote-allowed",
            attemptNumber: Number(row.attempts),
          }
        : null;
    });
  }

  async complete(input: {
    jobId: string;
    userId: string;
    candidates: Array<{
      id: string;
      title: string;
      amount: Money;
      due: DueValue;
      evidence: Array<{
        id: string;
        kind: "email_body_fragment" | "pdf_text_fragment";
        sourceItemRevisionId: string;
        attachmentId?: string;
        page?: number;
        startOffset: number;
        endOffset: number;
        quote: string;
        contentSha256: string;
      }>;
    }>;
  }): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const job = await client.query<{ source_item_revision_id: string }>(
        "SELECT source_item_revision_id FROM extraction_jobs WHERE id = $1 AND user_id = $2 AND state = 'running' FOR UPDATE",
        [input.jobId, input.userId],
      );
      if (job.rowCount !== 1)
        throw new Error("Extraction job cannot be completed twice");
      const sourceItemRevisionId = job.rows[0]!.source_item_revision_id;
      for (const candidate of input.candidates) {
        if (candidate.evidence.length === 0)
          throw new Error("Extraction candidate needs evidence");
        if (
          candidate.evidence.some(
            (evidence) =>
              evidence.sourceItemRevisionId !== sourceItemRevisionId,
          )
        ) {
          throw new Error("Extraction evidence revision does not match job");
        }
        for (const evidence of candidate.evidence) {
          await client.query(
            `INSERT INTO evidence(id, user_id, source_item_revision_id, kind, attachment_id, page, start_offset, end_offset, quote, content_sha256)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              evidence.id,
              input.userId,
              evidence.sourceItemRevisionId,
              evidence.kind,
              evidence.attachmentId ?? null,
              evidence.page ?? null,
              evidence.startOffset,
              evidence.endOffset,
              evidence.quote,
              evidence.contentSha256,
            ],
          );
        }
        await client.query(
          `INSERT INTO extraction_candidates(id, user_id, source_item_revision_id, extraction_job_id, title, amount, currency, due, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready')`,
          [
            candidate.id,
            input.userId,
            candidate.evidence[0]!.sourceItemRevisionId,
            input.jobId,
            candidate.title,
            candidate.amount.amount,
            candidate.amount.currency,
            candidate.due,
          ],
        );
        for (const evidence of candidate.evidence)
          await client.query(
            "INSERT INTO extraction_candidate_evidence(candidate_id, evidence_id, user_id, source_item_revision_id) VALUES ($1, $2, $3, $4)",
            [
              candidate.id,
              evidence.id,
              input.userId,
              candidate.evidence[0]!.sourceItemRevisionId,
            ],
          );
        await client.query(
          `INSERT INTO outbox_events(id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key, occurred_at, payload)
           VALUES ($1,$2,'obligation.candidate.created.v1','obligation',$3,$4,now(),$5)`,
          [
            randomUUID(),
            input.userId,
            candidate.id,
            `extraction:${candidate.id}`,
            {
              obligationId: candidate.id,
              sourceItemRevisionId: candidate.evidence[0]!.sourceItemRevisionId,
            },
          ],
        );
      }
      await client.query(
        "UPDATE extraction_jobs SET state = 'completed', completed_at = now(), claimed_at = NULL, last_error_code = NULL WHERE id = $1 AND user_id = $2 AND state = 'running'",
        [input.jobId, input.userId],
      );
    });
  }

  async fail(jobId: string, userId: string, code: string): Promise<void> {
    await this.pool.query(
      "UPDATE extraction_jobs SET state = 'manual_review', last_error_code = $3, completed_at = now(), claimed_at = NULL WHERE id = $1 AND user_id = $2 AND state = 'running'",
      [jobId, userId, code.slice(0, 160)],
    );
  }

  async recoverExpired(now = new Date(), leaseMs = 180_000): Promise<number> {
    const expiresAt = new Date(now.getTime() - leaseMs);
    const result = await this.pool.query(
      `UPDATE extraction_jobs SET state = 'manual_review', completed_at = $1, claimed_at = NULL, last_error_code = 'lease_expired'
       WHERE state = 'running' AND claimed_at < $2`,
      [now, expiresAt],
    );
    return result.rowCount ?? 0;
  }
}
