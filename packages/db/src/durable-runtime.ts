import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { OutboxEventSchema, type OutboxEvent } from "@crashmemory/contracts";
import { inTransaction } from "./client.ts";

export interface DispatchAttempt {
  event: OutboxEvent;
  attemptNumber: number;
  jobId: string;
  createdAt: string;
}

export interface RecoveryCursor {
  /** PostgreSQL timestamptz text keeps microseconds that JavaScript Date drops. */
  createdAt: string;
  eventId: string;
}

export interface RecoveryBatch {
  attempts: DispatchAttempt[];
  nextCursor: RecoveryCursor | null;
}

export interface ConsumerReceipt {
  state: "completed" | "skipped";
  attempts: number;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 160);
  }
  if (error instanceof Error) return error.name.slice(0, 160);
  return "runtime_error";
}

function mapEvent(row: Record<string, unknown>): OutboxEvent {
  return OutboxEventSchema.parse({
    id: String(row.id),
    userId: String(row.user_id),
    type: String(row.event_type),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    idempotencyKey: String(row.idempotency_key),
    occurredAt: (row.occurred_at as Date).toISOString(),
    payload: row.payload,
  });
}

export class DurableRuntimeRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Claims only events that have never received a transport acknowledgement.
   * An expired claim is safe to retry because the attempt/job identity is durable.
   */
  async claimForDispatch(
    limit = 100,
    now = new Date(),
    claimLeaseMs = 60_000,
  ): Promise<DispatchAttempt[]> {
    return this.claim(limit, now, claimLeaseMs, false);
  }

  /**
   * Recreates transport copies after Redis loss. It intentionally does not
   * alter consumer receipts: duplicate delivery is resolved at that boundary.
   */
  async claimForRecovery(
    limit = 100,
    cursor?: RecoveryCursor,
    now = new Date(),
  ): Promise<RecoveryBatch> {
    const attempts = await this.claim(limit, now, 0, true, cursor);
    const last = attempts.at(-1);
    return {
      attempts,
      nextCursor: last
        ? { createdAt: last.createdAt, eventId: last.event.id }
        : null,
    };
  }

  private async claim(
    limit: number,
    now: Date,
    claimLeaseMs: number,
    includePublished: boolean,
    cursor?: RecoveryCursor,
  ): Promise<DispatchAttempt[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Dispatch limit must be an integer between 1 and 1000");
    }
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `WITH candidates AS (
           SELECT id
           FROM outbox_events
           WHERE ($1::boolean OR published_at IS NULL)
             AND (claimed_at IS NULL OR claimed_at < ($2::timestamptz - ($3::bigint * interval '1 millisecond')))
             AND ($5::timestamptz IS NULL OR (created_at, id) > ($5, $6::uuid))
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $4
         )
         , claimed AS (
           UPDATE outbox_events o
           SET claimed_at = $2, attempts = o.attempts + 1, last_error_code = NULL
           FROM candidates
           WHERE o.id = candidates.id
           RETURNING o.*, o.created_at::text AS runtime_created_at
         )
         SELECT * FROM claimed ORDER BY created_at, id`,
        [
          includePublished,
          now,
          claimLeaseMs,
          limit,
          cursor?.createdAt ?? null,
          cursor?.eventId ?? null,
        ],
      );
      const attempts: DispatchAttempt[] = [];
      for (const row of result.rows) {
        const event = mapEvent(row);
        const attemptNumber = Number(row.attempts);
        // BullMQ reserves ':' in custom job IDs.
        const jobId = `${event.id}-${attemptNumber}`;
        await client.query(
          `INSERT INTO outbox_dispatch_attempts(event_id, attempt_number, job_id, state)
           VALUES ($1, $2, $3, 'prepared')`,
          [event.id, attemptNumber, jobId],
        );
        attempts.push({
          event,
          attemptNumber,
          jobId,
          createdAt: String(row.runtime_created_at),
        });
      }
      return attempts;
    });
  }

  async markEnqueued(
    attempt: DispatchAttempt,
    now = new Date(),
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const dispatch = await client.query(
        `UPDATE outbox_dispatch_attempts
         SET state = 'enqueued', enqueued_at = $4, error_code = NULL
         WHERE event_id = $1 AND attempt_number = $2 AND job_id = $3
           AND state IN ('prepared', 'enqueued')`,
        [attempt.event.id, attempt.attemptNumber, attempt.jobId, now],
      );
      if (dispatch.rowCount !== 1) {
        throw new Error("Outbox dispatch attempt is no longer available");
      }
      await client.query(
        `UPDATE outbox_events
         SET published_at = COALESCE(published_at, $2), claimed_at = NULL, last_error_code = NULL
         WHERE id = $1`,
        [attempt.event.id, now],
      );
    });
  }

  async markDispatchFailed(
    attempt: DispatchAttempt,
    error: unknown,
  ): Promise<void> {
    const code = errorCode(error);
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE outbox_dispatch_attempts
         SET state = 'failed', error_code = $4
         WHERE event_id = $1 AND attempt_number = $2 AND job_id = $3`,
        [attempt.event.id, attempt.attemptNumber, attempt.jobId, code],
      );
      await client.query(
        `UPDATE outbox_events
         SET claimed_at = NULL, last_error_code = $2
         WHERE id = $1`,
        [attempt.event.id, code],
      );
    });
  }

  async dispatchState(eventId: string): Promise<{
    publishedAt: Date | null;
    attempts: number;
    dispatches: Array<{ attemptNumber: number; state: string; jobId: string }>;
  } | null> {
    const event = await this.pool.query<Record<string, unknown>>(
      "SELECT published_at, attempts FROM outbox_events WHERE id = $1",
      [eventId],
    );
    if (event.rowCount === 0) return null;
    const dispatches = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt_number, state, job_id
       FROM outbox_dispatch_attempts WHERE event_id = $1 ORDER BY attempt_number`,
      [eventId],
    );
    return {
      publishedAt: (event.rows[0]?.published_at as Date | null) ?? null,
      attempts: Number(event.rows[0]?.attempts),
      dispatches: dispatches.rows.map((row) => ({
        attemptNumber: Number(row.attempt_number),
        state: String(row.state),
        jobId: String(row.job_id),
      })),
    };
  }

  async getEvent(eventId: string): Promise<OutboxEvent | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM outbox_events WHERE id = $1",
      [eventId],
    );
    return result.rowCount === 0 ? null : mapEvent(result.rows[0] ?? {});
  }

  /**
   * The domain effect and the completion receipt commit in one database
   * transaction. A BullMQ acknowledgement after this commit may be lost, but
   * a replay observes the completed receipt and does not repeat the effect.
   */
  async runIdempotentConsumer(
    consumerName: string,
    event: OutboxEvent,
    effect: (client: PoolClient) => Promise<void>,
  ): Promise<ConsumerReceipt> {
    if (consumerName.length === 0 || consumerName.length > 160) {
      throw new Error(
        "Consumer name is required and limited to 160 characters",
      );
    }
    let deferredError: unknown;
    const receipt = await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO event_consumer_receipts(consumer_name, event_id, state)
         VALUES ($1, $2, 'processing')
         ON CONFLICT (consumer_name, event_id) DO NOTHING`,
        [consumerName, event.id],
      );
      const current = await client.query<Record<string, unknown>>(
        `SELECT state, attempts FROM event_consumer_receipts
         WHERE consumer_name = $1 AND event_id = $2 FOR UPDATE`,
        [consumerName, event.id],
      );
      const row = current.rows[0];
      if (!row) throw new Error("Consumer receipt was not created");
      if (row.state === "completed") {
        return { state: "skipped" as const, attempts: Number(row.attempts) };
      }
      const attempts = Number(row.attempts) + 1;
      await client.query(
        `UPDATE event_consumer_receipts
         SET state = 'processing', attempts = $3, effect_started_at = now(),
             completed_at = NULL, last_error_code = NULL, updated_at = now()
         WHERE consumer_name = $1 AND event_id = $2`,
        [consumerName, event.id, attempts],
      );
      await client.query("SAVEPOINT consumer_effect");
      try {
        await effect(client);
        await client.query(
          `UPDATE event_consumer_receipts
           SET state = 'completed', completed_at = now(), updated_at = now()
           WHERE consumer_name = $1 AND event_id = $2`,
          [consumerName, event.id],
        );
        return { state: "completed" as const, attempts };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT consumer_effect");
        await client.query(
          `UPDATE event_consumer_receipts
           SET state = 'failed', last_error_code = $3, updated_at = now()
           WHERE consumer_name = $1 AND event_id = $2`,
          [consumerName, event.id, errorCode(error)],
        );
        deferredError = error;
        return { state: "skipped" as const, attempts };
      }
    });
    if (deferredError) throw deferredError;
    return receipt;
  }

  async getReceipt(
    consumerName: string,
    eventId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT consumer_name, event_id, state, attempts, effect_started_at,
              completed_at, last_error_code
       FROM event_consumer_receipts WHERE consumer_name = $1 AND event_id = $2`,
      [consumerName, eventId],
    );
    return result.rowCount === 0 ? null : (result.rows[0] ?? null);
  }
}

export function newRuntimeEffectId(): string {
  return randomUUID();
}
