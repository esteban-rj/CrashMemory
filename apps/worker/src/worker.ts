import { createPool, DurableRuntimeRepository } from "@crashmemory/db";
import {
  NotificationDispatcher,
  ReminderScheduler,
  TelegramBotApiProvider,
  TelegramGetUpdatesClient,
  TelegramLinkPollingRunner,
  TelegramLinkService,
  TelegramUpdateRecorder,
  registerNotificationConsumers,
} from "@crashmemory/notifications";
import {
  ConsumerRegistry,
  OutboxRelay,
  createOutboxQueue,
  startOutboxWorker,
} from "@crashmemory/runtime";
import { CredentialCipher, hashOpaqueToken } from "@crashmemory/security";

function required(name: "DATABASE_URL" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the durable worker`);
  return value;
}

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"), {
    application_name: "crashmemory-v03-worker",
  });
  const { queue, connection: queueConnection } = createOutboxQueue(
    required("REDIS_URL"),
  );
  const runtime = new DurableRuntimeRepository(pool);
  const registry = new ConsumerRegistry(runtime);
  let linkPoller: TelegramLinkPollingRunner | undefined;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const keyring = process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON;
  const activeKeyVersion = process.env.CREDENTIAL_ACTIVE_KEY_VERSION;
  if (telegramToken && keyring && activeKeyVersion) {
    const cipher = CredentialCipher.fromEnvironment(keyring, activeKeyVersion);
    registerNotificationConsumers(
      registry,
      new ReminderScheduler(
        pool,
        undefined,
        process.env.NOTIFICATIONS_AUTOMATIC_ENABLED === "true",
      ),
      new NotificationDispatcher(
        pool,
        cipher,
        new TelegramBotApiProvider(telegramToken),
      ),
    );
    const botKey = hashOpaqueToken(telegramToken);
    const links = new TelegramLinkService(pool, cipher);
    linkPoller = new TelegramLinkPollingRunner(
      pool,
      botKey,
      new TelegramGetUpdatesClient(telegramToken),
      new TelegramUpdateRecorder(pool, botKey, links),
    );
  }
  const relay = new OutboxRelay(runtime, queue);
  const { worker, connection: workerConnection } = startOutboxWorker({
    redisUrl: required("REDIS_URL"),
    registry,
  });
  let stopping = false;
  const pollIntervalMs = Number(
    process.env.TELEGRAM_POLL_INTERVAL_MS ?? "10000",
  );
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1_000 ||
    pollIntervalMs > 60_000
  ) {
    throw new Error(
      "TELEGRAM_POLL_INTERVAL_MS must be an integer from 1000 to 60000",
    );
  }
  let polling = false;
  const poll = async (): Promise<void> => {
    if (!linkPoller || polling || stopping) return;
    polling = true;
    try {
      await linkPoller.pollOnce();
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "worker",
          event: "telegram_poll_failed",
          code: error instanceof Error ? error.message : "telegram_poll_error",
        }),
      );
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), pollIntervalMs);
  void poll();
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(pollTimer);
    await worker.close();
    await queue.close();
    await workerConnection.quit();
    await queueConnection.quit();
    await pool.end();
  };
  worker.on("error", (error) => {
    console.error(
      JSON.stringify({
        component: "worker",
        event: "job_error",
        code: error.name,
      }),
    );
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  const replayed = await relay.recoverFromPostgres();
  const dispatched = await relay.dispatchPending();
  console.log(
    JSON.stringify({
      component: "worker",
      event: "started",
      replayed,
      dispatched,
      metrics: relay.getMetrics(),
    }),
  );
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : "runtime_error";
  console.error(
    JSON.stringify({ component: "worker", event: "startup_failed", code }),
  );
  process.exitCode = 1;
});
