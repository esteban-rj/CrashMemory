import { createPool, DurableRuntimeRepository } from "@crashmemory/db";
import { ReminderScheduler } from "@crashmemory/notifications";
import { OutboxRelay, createOutboxQueue } from "@crashmemory/runtime";

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

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"), {
    application_name: "crashmemory-v03-scheduler",
  });
  const { queue, connection } = createOutboxQueue(required("REDIS_URL"));
  const relay = new OutboxRelay(new DurableRuntimeRepository(pool), queue);
  const reminders = new ReminderScheduler(
    pool,
    undefined,
    process.env.NOTIFICATIONS_AUTOMATIC_ENABLED === "true",
  );
  let stopping = false;
  let running = false;
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
  const timer = setInterval(() => void tick(), intervalMs());
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
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
