import { createPool } from "@crashmemory/db";
import { ReminderScheduler } from "../index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.NOTIFICATIONS_AUTOMATIC_ENABLED !== "true") {
  throw new Error(
    "Set NOTIFICATIONS_AUTOMATIC_ENABLED=true before explicit backfill",
  );
}
const limit = Number(process.env.NOTIFICATIONS_BACKFILL_LIMIT ?? "100");
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
  throw new Error(
    "NOTIFICATIONS_BACKFILL_LIMIT must be an integer from 1 to 10000",
  );
}
const pool = createPool(databaseUrl, {
  application_name: "crashmemory-v09-reminder-backfill",
});
try {
  const scheduled = await new ReminderScheduler(
    pool,
    undefined,
    true,
  ).backfillConfirmed(new Date(), limit);
  console.log(
    JSON.stringify({
      component: "notifications",
      event: "backfill_completed",
      scanned: scheduled,
    }),
  );
} finally {
  await pool.end();
}
