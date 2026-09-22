import { createPool, DurableRuntimeRepository } from "@crashmemory/db";
import {
  ConsumerRegistry,
  OutboxRelay,
  createOutboxQueue,
  startOutboxWorker,
} from "@crashmemory/runtime";

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
