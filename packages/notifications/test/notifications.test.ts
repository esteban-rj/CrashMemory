import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createPool,
  inTransaction,
  migrate,
  NotificationRepository,
  ReminderRepository,
} from "@crashmemory/db";
import { CredentialCipher } from "@crashmemory/security";
import type { OutboxEvent } from "@crashmemory/contracts";
import {
  NotificationDispatcher,
  ReminderScheduler,
  TelegramBotApiProvider,
  TelegramLinkService,
  TelegramUpdateRecorder,
} from "../src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const cipher = new CredentialCipher(
  "test",
  new Map([["test", Buffer.alloc(32, 7)]]),
);

async function seedUser(pool: ReturnType<typeof createPool>): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users(id, email_normalized, password_hash, time_zone)
     VALUES ($1, $2, 'synthetic-password-hash', 'America/Bogota')`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

async function seedReminder(
  pool: ReturnType<typeof createPool>,
  userId: string,
): Promise<{
  reminderId: string;
  version: number;
  obligationId: string;
  versionId: string;
}> {
  const obligationId = randomUUID();
  const versionId = randomUUID();
  await inTransaction(pool, async (client) => {
    await client.query(
      "INSERT INTO obligations(id, user_id, state) VALUES ($1, $2, 'confirmed')",
      [obligationId, userId],
    );
    await client.query(
      `INSERT INTO obligation_versions(id, user_id, obligation_id, revision, title, due_kind, due_at, time_zone)
       VALUES ($1, $2, $3, 1, 'Factura sintética', 'instant', $4, 'America/Bogota')`,
      [versionId, userId, obligationId, new Date("2026-10-15T15:00:00.000Z")],
    );
    await client.query(
      "UPDATE obligations SET current_version_id = $1 WHERE id = $2",
      [versionId, obligationId],
    );
  });
  const reminderId = randomUUID();
  await new ReminderRepository(pool).create({
    id: reminderId,
    userId,
    obligationId,
    obligationVersionId: versionId,
    targetVersion: 1,
    scheduledFor: new Date("2026-10-14T15:00:00.000Z"),
    policy: [{ id: "synthetic", offsetMinutes: -1440 }],
    dedupeKey: `synthetic:${reminderId}`,
  });
  return { reminderId, version: 1, obligationId, versionId };
}

function deliveryEvent(
  userId: string,
  reminderId: string,
  targetVersion = 1,
): Extract<OutboxEvent, { type: "reminder.delivery.requested.v1" }> {
  return {
    id: randomUUID(),
    userId,
    type: "reminder.delivery.requested.v1",
    aggregateType: "reminder",
    aggregateId: reminderId,
    idempotencyKey: randomUUID(),
    occurredAt: "2026-09-22T12:00:00.000Z",
    payload: { reminderId, targetVersion },
  };
}

function versionEvent(
  userId: string,
  obligationId: string,
  obligationVersionId: string,
  revision: number,
): Extract<OutboxEvent, { type: "obligation.version.created.v1" }> {
  return {
    id: randomUUID(),
    userId,
    type: "obligation.version.created.v1",
    aggregateType: "obligation",
    aggregateId: obligationId,
    idempotencyKey: randomUUID(),
    occurredAt: "2026-09-22T12:00:00.000Z",
    payload: { obligationId, obligationVersionId, revision },
  };
}

test(
  "one-time bot link records the update before advancing its offset",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userId = await seedUser(pool);
    try {
      const links = new TelegramLinkService(pool, cipher);
      const challenge = await links.start(userId);
      const botKey = `synthetic-bot-${randomUUID()}`;
      const recorder = new TelegramUpdateRecorder(pool, botKey, links);
      assert.equal(
        await recorder.record({
          updateId: 77,
          chatType: "private",
          chatId: "123456",
          text: `/start ${challenge.token}`,
        }),
        "linked",
      );
      assert.equal(
        await recorder.record({
          updateId: 77,
          chatType: "private",
          chatId: "123456",
          text: `/start ${challenge.token}`,
        }),
        "ignored",
      );
      const groupChallenge = await links.start(userId);
      assert.equal(
        await recorder.record({
          updateId: 78,
          chatType: "group",
          chatId: "999",
          text: `/start ${groupChallenge.token}`,
        }),
        "ignored",
      );
      assert.equal(
        await new NotificationRepository(pool).getPollOffset(botKey),
        79,
      );
      const recipient = await new NotificationRepository(pool).activeRecipient(
        userId,
      );
      assert.ok(recipient);
      assert.equal(
        cipher.decrypt(
          recipient.encryptedChatId,
          `telegram-recipient:${userId}:${recipient.id}`,
        ),
        "123456",
      );
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "persisted delivery sends once; interrupted prepared attempt becomes unknown without HTTP",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userId = await seedUser(pool);
    const seen: RequestInit[] = [];
    try {
      const links = new TelegramLinkService(pool, cipher);
      const challenge = await links.start(userId);
      await links.acceptStart({ token: challenge.token, chatId: "123456" });
      const provider = new TelegramBotApiProvider(
        "synthetic-token",
        async (_url, init) => {
          seen.push(init ?? {});
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 42 } }),
            { status: 200 },
          );
        },
      );
      const dispatcher = new NotificationDispatcher(pool, cipher, provider);
      const first = await seedReminder(pool, userId);
      await dispatcher.deliver(deliveryEvent(userId, first.reminderId));
      await dispatcher.deliver(deliveryEvent(userId, first.reminderId));
      assert.equal(seen.length, 1);
      const sent = await pool.query<{ outcome: string }>(
        `SELECT r.outcome FROM notification_delivery_attempts a
       JOIN notification_delivery_resolutions r ON r.attempt_id = a.id
       WHERE a.reminder_id = $1`,
        [first.reminderId],
      );
      assert.deepEqual(sent.rows, [{ outcome: "sent" }]);

      const second = await seedReminder(pool, userId);
      await inTransaction(pool, (client) =>
        new NotificationRepository(client).prepareDelivery({
          id: randomUUID(),
          reminderId: second.reminderId,
          userId,
          targetVersion: second.version,
        }),
      );
      await dispatcher.deliver(deliveryEvent(userId, second.reminderId));
      assert.equal(seen.length, 1);
      const unknown = await pool.query<{ outcome: string; error_code: string }>(
        `SELECT r.outcome, r.error_code FROM notification_delivery_attempts a
       JOIN notification_delivery_resolutions r ON r.attempt_id = a.id
       WHERE a.reminder_id = $1`,
        [second.reminderId],
      );
      assert.deepEqual(unknown.rows, [
        { outcome: "unknown", error_code: "interrupted_after_prepare" },
      ]);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "replayed and late reminder events preserve the current confirmed version",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userId = await seedUser(pool);
    try {
      const first = await seedReminder(pool, userId);
      const scheduler = new ReminderScheduler(pool, undefined, true);
      const firstEvent = versionEvent(
        userId,
        first.obligationId,
        first.versionId,
        1,
      );
      await scheduler.scheduleForVersion(firstEvent);
      await scheduler.scheduleForVersion(firstEvent);
      const firstCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM reminders WHERE obligation_version_id = $1",
        [first.versionId],
      );
      assert.equal(firstCount.rows[0]?.count, "3");

      const secondVersionId = randomUUID();
      await inTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO obligation_versions(id, user_id, obligation_id, revision, title, due_kind, due_at, time_zone)
         VALUES ($1, $2, $3, 2, 'Factura sintética corregida', 'instant', $4, 'America/Bogota')`,
          [
            secondVersionId,
            userId,
            first.obligationId,
            new Date("2026-10-20T15:00:00.000Z"),
          ],
        );
        await client.query(
          "UPDATE obligations SET current_version_id = $1 WHERE id = $2",
          [secondVersionId, first.obligationId],
        );
      });
      await scheduler.scheduleForVersion(firstEvent);
      await scheduler.scheduleForVersion(
        versionEvent(userId, first.obligationId, secondVersionId, 2),
      );
      await scheduler.cancelForChange({
        id: randomUUID(),
        userId,
        type: "obligation.reminder.reschedule.requested.v1",
        aggregateType: "obligation",
        aggregateId: first.obligationId,
        idempotencyKey: randomUUID(),
        occurredAt: "2026-09-22T12:05:00.000Z",
        payload: { obligationId: first.obligationId, cause: "due_changed" },
      });
      const states = await pool.query<{
        obligation_version_id: string;
        state: string;
      }>(
        "SELECT obligation_version_id::text, state FROM reminders WHERE obligation_id = $1 ORDER BY obligation_version_id, state",
        [first.obligationId],
      );
      assert.equal(
        states.rows.filter(
          (row) =>
            row.obligation_version_id === first.versionId &&
            row.state === "cancelled",
        ).length,
        3,
      );
      assert.equal(
        states.rows.filter(
          (row) =>
            row.obligation_version_id === secondVersionId &&
            row.state === "scheduled",
        ).length,
        2,
      );
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);
