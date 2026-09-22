import { createPool, DurableRuntimeRepository } from "@crashmemory/db";
import { PostgresGmailSyncRunner } from "@crashmemory/gmail/runner";
import { ReminderScheduler } from "@crashmemory/notifications";
import { OutboxRelay, createOutboxQueue } from "@crashmemory/runtime";
import { CredentialCipher } from "@crashmemory/security";

function required(name: "DATABASE_URL" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the durable scheduler`);
  return value;
}

function intervalMs(): number {
  const value = Number(process.env.OUTBOX_DISPATCH_INTERVAL_MS ?? "5000");
  if (!Number.isInteger(value) || value < 250 || value > 60_000) {
    throw new Error(
      "OUTBOX_DISPATCH_INTERVAL_MS must be an integer from 250 to 60000",
    );
  }
  return value;
}

function gmailSyncIntervalMs(): number {
  const value = Number(process.env.GMAIL_SYNC_INTERVAL_MS ?? "300000");
  if (!Number.isInteger(value) || value < 60_000 || value > 86_400_000) {
    throw new Error(
      "GMAIL_SYNC_INTERVAL_MS must be an integer from 60000 to 86400000",
    );
  }
  return value;
}

function gmailRunner(
  pool: ReturnType<typeof createPool>,
): PostgresGmailSyncRunner | undefined {
  if (process.env.GMAIL_SYNC_ENABLED !== "true") return undefined;
  const requiredNames = [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_PUBSUB_TOPIC",
    "CREDENTIAL_ENCRYPTION_KEYS_JSON",
    "CREDENTIAL_ACTIVE_KEY_VERSION",
    "OBJECT_STORAGE_BUCKET",
  ] as const;
  for (const name of requiredNames) {
    if (!process.env[name])
      throw new Error(`${name} is required when GMAIL_SYNC_ENABLED=true`);
  }
  return new PostgresGmailSyncRunner(pool, {
    clientId: process.env.GMAIL_CLIENT_ID!,
    clientSecret: process.env.GMAIL_CLIENT_SECRET!,
    pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC!,
    credentialCipher: CredentialCipher.fromEnvironment(
      process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON,
      process.env.CREDENTIAL_ACTIVE_KEY_VERSION,
    ),
    objectStorage: {
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
      bucket: process.env.OBJECT_STORAGE_BUCKET!,
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
    },
  });
}

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"), {
    application_name: "crashmemory-v03-scheduler",
  });
  const { queue, connection } = createOutboxQueue(required("REDIS_URL"));
  const relay = new OutboxRelay(new DurableRuntimeRepository(pool), queue);
  const gmail = gmailRunner(pool);
  const gmailInterval = gmail ? gmailSyncIntervalMs() : 0;
  let lastGmailRun = 0;
  const reminders = new ReminderScheduler(
    pool,
    undefined,
    process.env.NOTIFICATIONS_AUTOMATIC_ENABLED === "true",
  );
  let stopping = false;
  let running = false;
  let activeTick: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    if (running || stopping) return;
    running = true;
    try {
      const scheduled = await reminders.enqueueDue();
      const dispatched = await relay.dispatchPending();
      if (scheduled > 0 || dispatched > 0) {
        console.log(
          JSON.stringify({
            component: "scheduler",
            event: "dispatched",
            scheduled,
            count: dispatched,
            metrics: relay.getMetrics(),
          }),
        );
      }
      if (gmail && Date.now() - lastGmailRun >= gmailInterval) {
        lastGmailRun = Date.now();
        const synchronized = await gmail.runOnce();
        console.log(
          JSON.stringify({
            component: "scheduler",
            event: "gmail_sync_completed",
            connections: synchronized,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "scheduler",
          event: "dispatch_failed",
          code: error instanceof Error ? error.name : "runtime_error",
        }),
      );
    } finally {
      running = false;
    }
  };
  const replayed = await relay.recoverFromPostgres();
  console.log(
    JSON.stringify({
      component: "scheduler",
      event: "started",
      replayed,
      metrics: relay.getMetrics(),
    }),
  );
  const runTick = (): void => {
    if (activeTick) return;
    const current = tick();
    activeTick = current;
    void current.finally(() => {
      if (activeTick === current) activeTick = undefined;
    });
  };
  const timer = setInterval(runTick, intervalMs());
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // A backup must only start after this wait: Gmail sync can be in HTTP or
    // object persistence, and closing the pool first would leave it racing.
    await activeTick;
    await queue.close();
    await connection.quit();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      component: "scheduler",
      event: "startup_failed",
      code: error instanceof Error ? error.name : "runtime_error",
    }),
  );
  process.exitCode = 1;
});
