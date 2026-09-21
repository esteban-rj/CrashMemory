import { Pool, type PoolClient, type PoolConfig } from "pg";

export type Queryable = Pick<Pool | PoolClient, "query">;

export function createPool(
  connectionString: string,
  overrides: PoolConfig = {},
): Pool {
  return new Pool({
    connectionString,
    max: 10,
    application_name: "crashmemory-v02",
    ...overrides,
  });
}

export async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
