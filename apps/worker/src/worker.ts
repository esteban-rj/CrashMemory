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
  ConsumerRegistry,
  OutboxRelay,
  S3ObjectStorage,
  createOutboxQueue,
  startOutboxWorker,
} from "@crashmemory/runtime";
import { registerExtractionConsumer } from "./extraction-consumer.ts";

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
  registerExtractionConsumer(registry);
  const relay = new OutboxRelay(runtime, queue);
  const { worker, connection: workerConnection } = startOutboxWorker({
    redisUrl: required("REDIS_URL"),
    registry,
  });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await worker.close();
    await queue.close();
    await workerConnection.quit();
    await queueConnection.quit();
    clearInterval(extractionTimer);
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
  await extractionRepository.recoverExpired();
  const extractionTimer = setInterval(() => void runner.runOne(), 1_000);
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
