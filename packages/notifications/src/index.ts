import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  NotificationRepository,
  ReminderRepository,
  inTransaction,
  type DeliveryAttemptRecord,
} from "@crashmemory/db";
import type { OutboxEvent } from "@crashmemory/contracts";
import {
  CredentialCipher,
  generateOpaqueToken,
  hashOpaqueToken,
} from "@crashmemory/security";
import type { ConsumerRegistry } from "@crashmemory/runtime";

export interface TelegramProvider {
  send(input: {
    chatId: string;
    text: string;
  }): Promise<
    | { outcome: "sent"; providerMessageId: string }
    | { outcome: "failed"; errorCode: string }
    | { outcome: "unknown"; errorCode: string }
  >;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/** Telegram adapter deliberately exposes neither the token nor response body. */
export class TelegramBotApiProvider implements TelegramProvider {
  constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!botToken) throw new Error("Telegram bot token is required");
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 60_000
    ) {
      throw new Error("Telegram timeout must be an integer from 1000 to 60000");
    }
  }

  async send(input: { chatId: string; text: string }) {
    try {
      const response = await fetchWithTimeout(
        this.fetcher,
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
        },
        this.timeoutMs,
      );
      if (!response.ok)
        return {
          outcome: "failed" as const,
          errorCode: `telegram_http_${response.status}`,
        };
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return {
          outcome: "unknown" as const,
          errorCode: "telegram_invalid_response",
        };
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { ok?: unknown }).ok !== true
      ) {
        return {
          outcome: "unknown" as const,
          errorCode: "telegram_ambiguous_response",
        };
      }
      const messageId = (parsed as { result?: { message_id?: unknown } }).result
        ?.message_id;
      if (typeof messageId !== "number")
        return {
          outcome: "unknown" as const,
          errorCode: "telegram_missing_message_id",
        };
      return { outcome: "sent" as const, providerMessageId: String(messageId) };
    } catch {
      return {
        outcome: "unknown" as const,
        errorCode: "telegram_transport_error",
      };
    }
  }
}

export interface TelegramLinkChallenge {
  token: string;
  expiresAt: Date;
}

export class TelegramLinkService {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: CredentialCipher,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async start(
    userId: string,
    now = new Date(),
  ): Promise<TelegramLinkChallenge> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await new NotificationRepository(this.pool).createLinkChallenge({
      id: randomUUID(),
      userId,
      tokenHash: hashOpaqueToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** Accepts only a one-time challenge; a raw chat id is encrypted at rest. */
  async acceptStart(input: {
    token: string;
    chatId: string;
    now?: Date;
  }): Promise<"linked" | "ignored"> {
    if (!/^-?[0-9]{1,20}$/.test(input.chatId)) return "ignored";
    return inTransaction(this.pool, (client) =>
      this.acceptStartInTransaction(client, input),
    );
  }

  async acceptStartInTransaction(
    client: PoolClient,
    input: { token: string; chatId: string; now?: Date },
  ): Promise<"linked" | "ignored"> {
    if (!/^-?[0-9]{1,20}$/.test(input.chatId)) return "ignored";
    const challengeHash = hashOpaqueToken(input.token);
    const lookup = await client.query<{ user_id: string }>(
      `SELECT user_id FROM telegram_link_challenges
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2 FOR UPDATE`,
      [challengeHash, input.now ?? new Date()],
    );
    const userId = lookup.rows[0]?.user_id;
    if (!userId) return "ignored";
    const recipientId = randomUUID();
    return new NotificationRepository(client).consumeChallengeAndSetRecipient({
      challengeTokenHash: challengeHash,
      recipient: {
        id: recipientId,
        userId,
        encryptedChatId: this.cipher.encrypt(
          input.chatId,
          `telegram-recipient:${userId}:${recipientId}`,
        ),
      },
      now: input.now,
    });
  }
}

export interface TelegramUpdate {
  updateId: number;
  chatId?: string;
  chatType?: string;
  text?: string;
}

async function fetchWithTimeout(
  fetcher: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class TelegramGetUpdatesClient {
  constructor(
    private readonly botToken: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!botToken) throw new Error("Telegram bot token is required");
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 60_000
    ) {
      throw new Error("Telegram timeout must be an integer from 1000 to 60000");
    }
  }

  async getUpdates(offset: number | null): Promise<TelegramUpdate[]> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetcher,
        `https://api.telegram.org/bot${this.botToken}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset: offset ?? undefined,
            allowed_updates: ["message"],
          }),
        },
        this.timeoutMs,
      );
    } catch {
      throw new Error("telegram_poll_transport_error");
    }
    if (!response.ok) throw new Error(`telegram_poll_http_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("telegram_poll_invalid_response");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { ok?: unknown }).ok !== true ||
      !Array.isArray((payload as { result?: unknown }).result)
    ) {
      throw new Error("telegram_poll_ambiguous_response");
    }
    return (
      payload as { result: Array<Record<string, unknown>> }
    ).result.flatMap((raw) => {
      const updateId = raw.update_id;
      const message = raw.message as
        { text?: unknown; chat?: { id?: unknown; type?: unknown } } | undefined;
      if (typeof updateId !== "number" || !Number.isSafeInteger(updateId))
        return [];
      return [
        {
          updateId,
          text: typeof message?.text === "string" ? message.text : undefined,
          chatId:
            typeof message?.chat?.id === "number" ||
            typeof message?.chat?.id === "string"
              ? String(message.chat.id)
              : undefined,
          chatType:
            typeof message?.chat?.type === "string"
              ? message.chat.type
              : undefined,
        },
      ];
    });
  }
}

/**
 * Polling records each update before advancing its durable offset.  Webhooks
 * are optional; an HTTP webhook must validate Telegram's secret token before
 * calling `record`.
 */
export class TelegramUpdateRecorder {
  constructor(
    private readonly pool: Pool,
    private readonly botKey: string,
    private readonly links: TelegramLinkService,
  ) {}

  async record(update: TelegramUpdate): Promise<"linked" | "ignored"> {
    if (!Number.isSafeInteger(update.updateId) || update.updateId < 0)
      return "ignored";
    return inTransaction(this.pool, async (client) => {
      const repository = new NotificationRepository(client);
      const fresh = await repository.registerTelegramUpdate({
        botKey: this.botKey,
        updateId: update.updateId,
      });
      let result: "linked" | "ignored" = "ignored";
      if (
        fresh &&
        update.chatType === "private" &&
        update.chatId &&
        update.text
      ) {
        const match = /^\/start\s+([A-Za-z0-9_-]{20,})\s*$/.exec(update.text);
        if (match)
          result = await this.links.acceptStartInTransaction(client, {
            token: match[1],
            chatId: update.chatId,
          });
      }
      // This runs only after the update row exists.  It is monotonic, so a
      // duplicate delivery cannot move the cursor backwards.
      await repository.setPollOffset(this.botKey, update.updateId + 1);
      return result;
    });
  }
}

export class TelegramLinkPollingRunner {
  constructor(
    private readonly pool: Pool,
    private readonly botKey: string,
    private readonly updates: TelegramGetUpdatesClient,
    private readonly recorder: TelegramUpdateRecorder,
  ) {}

  async pollOnce(): Promise<number> {
    const offset = await new NotificationRepository(this.pool).getPollOffset(
      this.botKey,
    );
    const updates = await this.updates.getUpdates(offset);
    for (const update of updates.sort(
      (left, right) => left.updateId - right.updateId,
    )) {
      await this.recorder.record(update);
    }
    return updates.length;
  }
}

export type ReminderPolicy = ReadonlyArray<{
  id: string;
  offsetMinutes: number;
}>;
export const DEFAULT_REMINDER_POLICY: ReminderPolicy = Object.freeze([
  { id: "one_day", offsetMinutes: -24 * 60 },
  { id: "due", offsetMinutes: 0 },
]);

function eventInsert(
  client: { query: Pool["query"] },
  event: OutboxEvent,
): Promise<unknown> {
  return client.query(
    `INSERT INTO outbox_events(id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key, occurred_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING`,
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
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

export class ReminderScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly policy: ReminderPolicy = DEFAULT_REMINDER_POLICY,
    private readonly automaticDeliveryEnabled = false,
  ) {}

  async scheduleForVersion(
    event: Extract<OutboxEvent, { type: "obligation.version.created.v1" }>,
    existingClient?: PoolClient,
    notBefore?: Date,
  ): Promise<void> {
    if (!this.automaticDeliveryEnabled) return;
    const schedule = async (client: PoolClient): Promise<void> => {
      const version = await client.query<Record<string, unknown>>(
        `SELECT o.state, v.due_at, (v.due_date::timestamp AT TIME ZONE v.time_zone) AS civil_due_at
         FROM obligations o JOIN obligation_versions v ON v.id = $3 AND v.obligation_id = o.id
         WHERE o.id = $1 AND o.user_id = $2 AND v.user_id = $2
           AND o.current_version_id = v.id FOR UPDATE`,
        [
          event.payload.obligationId,
          event.userId,
          event.payload.obligationVersionId,
        ],
      );
      const row = version.rows[0];
      if (!row || row.state !== "confirmed") return;
      const dueAt = asDate(row.due_at) ?? asDate(row.civil_due_at);
      if (!dueAt) return;
      await new NotificationRepository(client).cancelObsoleteForObligation(
        event.userId,
        event.payload.obligationId,
        event.payload.obligationVersionId,
      );
      for (const policy of this.policy) {
        const scheduledFor = new Date(
          dueAt.getTime() + policy.offsetMinutes * 60_000,
        );
        // Backfill is explicit and never turns historical confirmed items into
        // an immediate notification burst after policy is enabled.
        if (notBefore && scheduledFor < notBefore) continue;
        await new ReminderRepository(client).create({
          id: randomUUID(),
          userId: event.userId,
          obligationId: event.payload.obligationId,
          obligationVersionId: event.payload.obligationVersionId,
          targetVersion: event.payload.revision,
          scheduledFor,
          policy,
          dedupeKey: `reminder:${event.payload.obligationVersionId}:${policy.id}`,
        });
      }
    };
    if (existingClient) return schedule(existingClient);
    await inTransaction(this.pool, schedule);
  }

  /**
   * Enabling automatic notifications does not replay already acknowledged
   * version events. Operators run this deliberate, idempotent backfill after
   * reviewing policy quality. Existing dedupe keys make repeated runs safe.
   */
  async backfillConfirmed(now = new Date(), limit = 100): Promise<number> {
    if (!this.automaticDeliveryEnabled) return 0;
    const versions = await this.pool.query<Record<string, unknown>>(
      `SELECT o.id AS obligation_id, o.user_id, v.id AS obligation_version_id, v.revision
       FROM obligations o JOIN obligation_versions v ON v.id = o.current_version_id
       WHERE o.state = 'confirmed' AND o.user_id = v.user_id
       ORDER BY o.updated_at, o.id LIMIT $1`,
      [limit],
    );
    for (const version of versions.rows) {
      await this.scheduleForVersion(
        {
          id: randomUUID(),
          userId: String(version.user_id),
          type: "obligation.version.created.v1",
          aggregateType: "obligation",
          aggregateId: String(version.obligation_id),
          idempotencyKey: `reminder-backfill:${version.obligation_version_id}`,
          occurredAt: now.toISOString(),
          payload: {
            obligationId: String(version.obligation_id),
            obligationVersionId: String(version.obligation_version_id),
            revision: Number(version.revision),
          },
        },
        undefined,
        now,
      );
    }
    return versions.rowCount ?? 0;
  }

  async cancelForChange(
    event: Extract<
      OutboxEvent,
      { type: "obligation.reminder.reschedule.requested.v1" }
    >,
    existingClient?: PoolClient,
  ): Promise<void> {
    const cancel = async (client: PoolClient): Promise<void> => {
      const canonical = await client.query<Record<string, unknown>>(
        `SELECT state, current_version_id FROM obligations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [event.payload.obligationId, event.userId],
      );
      const row = canonical.rows[0];
      const repository = new NotificationRepository(client);
      if (!row || row.state !== "confirmed") {
        await repository.cancelForObligation(
          event.userId,
          event.payload.obligationId,
        );
      } else if (row.state === "confirmed" && row.current_version_id) {
        await repository.cancelObsoleteForObligation(
          event.userId,
          event.payload.obligationId,
          String(row.current_version_id),
        );
      }
    };
    if (existingClient) return cancel(existingClient);
    await inTransaction(this.pool, cancel);
  }

  async enqueueDue(now = new Date(), limit = 100): Promise<number> {
    if (!this.automaticDeliveryEnabled) return 0;
    return inTransaction(this.pool, async (client) => {
      const reminders = await client.query<Record<string, unknown>>(
        `SELECT id, user_id, target_version FROM reminders
         WHERE state = 'scheduled' AND scheduled_for <= $1
         ORDER BY scheduled_for, id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      for (const reminder of reminders.rows) {
        const reminderId = String(reminder.id);
        const userId = String(reminder.user_id);
        const targetVersion = Number(reminder.target_version);
        await client.query(
          "UPDATE reminders SET state = 'delivering', updated_at = now() WHERE id = $1",
          [reminderId],
        );
        await eventInsert(client, {
          id: randomUUID(),
          userId,
          type: "reminder.delivery.requested.v1",
          aggregateType: "reminder",
          aggregateId: reminderId,
          idempotencyKey: `reminder-delivery:${reminderId}:${targetVersion}`,
          occurredAt: now.toISOString(),
          payload: { reminderId, targetVersion },
        });
      }
      return reminders.rowCount ?? 0;
    });
  }
}

export class NotificationDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: CredentialCipher,
    private readonly provider: TelegramProvider,
  ) {}

  async deliver(
    event: Extract<OutboxEvent, { type: "reminder.delivery.requested.v1" }>,
  ): Promise<void> {
    const prepared = await inTransaction(this.pool, (client) =>
      new NotificationRepository(client).prepareDelivery({
        id: randomUUID(),
        reminderId: event.payload.reminderId,
        userId: event.userId,
        targetVersion: event.payload.targetVersion,
      }),
    );
    if (prepared.state !== "ready") return;
    const result = await this.send(
      prepared.attempt,
      event.payload.targetVersion,
    );
    await inTransaction(this.pool, async (client) => {
      const repository = new NotificationRepository(client);
      const resolved = await repository.resolveDelivery({
        attemptId: prepared.attempt.id,
        ...result,
      });
      if (!resolved) return;
      await eventInsert(client, {
        id: randomUUID(),
        userId: resolved.userId,
        type: "reminder.delivery.resolved.v1",
        aggregateType: "reminder",
        aggregateId: resolved.reminderId,
        idempotencyKey: `reminder-resolved:${prepared.attempt.id}`,
        occurredAt: new Date().toISOString(),
        payload: {
          reminderId: resolved.reminderId,
          attemptId: prepared.attempt.id,
          outcome: result.outcome,
        },
      });
    });
  }

  private async send(attempt: DeliveryAttemptRecord, targetVersion: number) {
    const repository = new NotificationRepository(this.pool);
    if (
      !(await repository.isDeliveryCurrent({
        reminderId: attempt.reminderId,
        userId: attempt.userId,
        targetVersion,
      }))
    ) {
      return {
        outcome: "failed" as const,
        errorCode: "reminder_cancelled_before_delivery",
      };
    }
    const recipient = await repository.activeRecipient(attempt.userId);
    if (!recipient)
      return {
        outcome: "failed" as const,
        errorCode: "telegram_recipient_missing",
      };
    let chatId: string;
    try {
      chatId = this.cipher.decrypt(
        recipient.encryptedChatId,
        `telegram-recipient:${recipient.userId}:${recipient.id}`,
      );
    } catch {
      return {
        outcome: "failed" as const,
        errorCode: "telegram_recipient_unavailable",
      };
    }
    return this.provider.send({
      chatId,
      text: "Tienes un recordatorio pendiente en CrashMemory.",
    });
  }
}

export function registerNotificationConsumers(
  registry: ConsumerRegistry,
  scheduler: ReminderScheduler,
  dispatcher?: NotificationDispatcher,
): void {
  registry.register({
    name: "notifications.schedule-version.v1",
    eventTypes: ["obligation.version.created.v1"],
    handle: async (event, client) => {
      if (event.type !== "obligation.version.created.v1")
        throw new Error("Unexpected notification event");
      await scheduler.scheduleForVersion(event, client);
    },
  });
  registry.register({
    name: "notifications.cancel-obsolete.v1",
    eventTypes: ["obligation.reminder.reschedule.requested.v1"],
    handle: async (event, client) => {
      if (event.type !== "obligation.reminder.reschedule.requested.v1")
        throw new Error("Unexpected notification event");
      await scheduler.cancelForChange(event, client);
    },
  });
  if (dispatcher)
    registry.registerExternal({
      name: "notifications.telegram-delivery.v1",
      eventTypes: ["reminder.delivery.requested.v1"],
      handle: async (event) => {
        if (event.type !== "reminder.delivery.requested.v1")
          throw new Error("Unexpected notification event");
        await dispatcher.deliver(event);
      },
    });
}
