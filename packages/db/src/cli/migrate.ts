import { createPool } from "../client.ts";
import { migrate } from "../migrate.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(
    applied.length === 0
      ? "Database is up to date"
      : `Applied: ${applied.join(", ")}`,
  );
} finally {
  await pool.end();
}
