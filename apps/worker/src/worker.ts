import {
  createPool,
  DurableRuntimeRepository,
  ExtractionRepository,
  ModelBudgetRepository,
} from "@crashmemory/db";
import {
  DurableExtractionRunner,
  ExtractionService,
  PostgresExtractionDocumentLoader,
} from "@crashmemory/extraction";
import {
  loadRemoteModelConfig,
  ModelGateway,
  OpenAiResponsesAdapter,
} from "@crashmemory/model-gateway";
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
  S3ObjectStorage,
  createOutboxQueue,
  startOutboxWorker,
} from "@crashmemory/runtime";
import { CredentialCipher, hashOpaqueToken } from "@crashmemory/security";
import {
  loadExtractionPrivacyProfile,
  registerExtractionConsumer,
} from "./extraction-consumer.ts";
import { ExtractionLoop } from "./extraction-loop.ts";

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
  const extractionRepository = new ExtractionRepository(pool);
  const storage = new S3ObjectStorage({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? "crashmemory",
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
  });
  const modelConfig = loadRemoteModelConfig();
  const runner = new DurableExtractionRunner(
    new ExtractionService(
      new ModelGateway({
        remoteConfig: modelConfig,
        remote: new OpenAiResponsesAdapter(modelConfig),
        budget: new ModelBudgetRepository(pool),
      }),
    ),
    extractionRepository,
    new PostgresExtractionDocumentLoader(pool, extractionRepository, storage),
  );
  const registry = new ConsumerRegistry(runtime);
  registerExtractionConsumer(registry, loadExtractionPrivacyProfile());

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
  const extractionLoop = new ExtractionLoop({
    recoverExpired: () => extractionRepository.recoverExpired(),
    runOne: () => runner.runOne(),
    report: (event, code) =>
      console.error(JSON.stringify({ component: "worker", event, code })),
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
          code: error instanceof Error ? error.name : "telegram_poll_error",
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
    await extractionLoop.stop();
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
  await extractionLoop.start();
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
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : "runtime_error";
  console.error(
    JSON.stringify({ component: "worker", event: "startup_failed", code }),
  );
  process.exitCode = 1;
});
