import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export async function withMigrationLock<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let discardConnection = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [2026092002]);
    locked = true;
    return await operation(client);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    if (locked && !discardConnection) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [2026092002]);
      } catch {
        discardConnection = true;
      }
    }
    client.release(discardConnection);
  }
}

export async function migrate(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  return withMigrationLock(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const completed = new Set(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations",
        )
      ).rows.map(({ version }) => version),
    );
    for (const file of (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const version = file.replace(/\.sql$/, "");
      if (completed.has(version)) continue;
      await client.query(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
      applied.push(version);
    }
    return applied;
  });
}
