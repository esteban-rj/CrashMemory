import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  SourceRepository,
  UserRepository,
  createPool,
  migrate,
  type DurableRuntimeRepository as DurableRuntimeRepositoryType,
  DurableRuntimeRepository,
} from "@crashmemory/db";
import type { OutboxEvent } from "@crashmemory/contracts";
import {
  AuthorizedBlobStorage,
  ConsumerRegistry,
  MemoryObjectStorage,
  OutboxRelay,
  S3ObjectStorage,
  createOutboxQueue,
} from "../src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const objectStorageEndpoint = process.env.TEST_OBJECT_STORAGE_ENDPOINT;
const objectStorageBucket = process.env.TEST_OBJECT_STORAGE_BUCKET;

async function setup(max = 10): Promise<{
  pool: ReturnType<typeof createPool>;
  runtime: DurableRuntimeRepositoryType;
  userId: string;
}> {
  const pool = createPool(databaseUrl!, { max });
  await migrate(pool);
  const userId = randomUUID();
  await new UserRepository(pool).create({
    id: userId,
    emailNormalized: `${userId}@example.test`,
    passwordHash: "synthetic-password-hash",
    timeZone: "America/Bogota",
  });
  return { pool, runtime: new DurableRuntimeRepository(pool), userId };
}

async function createEvent(input: {
  pool: ReturnType<typeof createPool>;
  userId: string;
  createdAt?: string;
}): Promise<OutboxEvent> {
  const event: OutboxEvent = {
    id: randomUUID(),
    userId: input.userId,
    type: "source.item.revision.created.v1",
    aggregateType: "source_item",
    aggregateId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: "2026-09-20T12:00:00.000Z",
    payload: { sourceItemId: randomUUID(), sourceItemRevisionId: randomUUID() },
  };
  await input.pool.query(
    `INSERT INTO outbox_events(
       id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key,
       occurred_at, payload, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
    [
      event.id,
      event.userId,
      event.type,
      event.aggregateType,
      event.aggregateId,
      event.idempotencyKey,
      event.occurredAt,
      event.payload,
      input.createdAt ?? null,
    ],
  );
  return event;
}

function queueThat(
  add: (name: string, event: OutboxEvent) => Promise<unknown>,
) {
  return { add } as never;
}

test(
  "committed outbox event survives enqueue failure and is replayed",
  { skip: !databaseUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    try {
      const event = await createEvent({ pool, userId });
      const failed = new OutboxRelay(
        runtime,
        queueThat(async () => {
          throw new Error("synthetic redis outage");
        }),
      );
      assert.equal(await failed.dispatchPending(), 0);
      assert.equal((await runtime.dispatchState(event.id))?.publishedAt, null);

      const seen: OutboxEvent[] = [];
      const replay = new OutboxRelay(
        runtime,
        queueThat(async (_name, job) => {
          seen.push(job);
        }),
      );
      // Pending outbox work belongs to every package sharing this isolated
      // test database.  This relay may legitimately replay more than this
      // fixture; the assertion is that this failed event is among them.
      assert.ok((await replay.dispatchPending()) >= 1);
      assert.ok(seen.some((entry) => entry.id === event.id));
      const state = await runtime.dispatchState(event.id);
      assert.ok(state?.publishedAt);
      assert.deepEqual(
        state?.dispatches.map((entry) => entry.state),
        ["failed", "enqueued"],
      );
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "recovery paginates microsecond timestamps without starving later events",
  { skip: !databaseUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    try {
      const events = await Promise.all([
        createEvent({ pool, userId, createdAt: "2026-09-20T12:00:00.123456Z" }),
        createEvent({ pool, userId, createdAt: "2026-09-20T12:00:00.123457Z" }),
        createEvent({ pool, userId, createdAt: "2026-09-20T12:00:00.123458Z" }),
      ]);
      const received: OutboxEvent[] = [];
      const relay = new OutboxRelay(
        runtime,
        queueThat(async (_name, event) => {
          received.push(event);
        }),
      );
      // Other package tests can append durable events at the same time.  The
      // recovery scan is global by design, so the invariant is that every
      // event created here is reached, never that this test owns the queue.
      assert.ok((await relay.recoverFromPostgres(2)) >= 3);
      const receivedIds = new Set(received.map((event) => event.id));
      for (const event of events) assert.ok(receivedIds.has(event.id));
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "Redis flush is recovered from PostgreSQL without changing consumer state",
  { skip: !databaseUrl || !redisUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    const queueName = `runtime-v03-${randomUUID()}`;
    const { queue, connection } = createOutboxQueue(redisUrl!, queueName);
    try {
      const event = await createEvent({ pool, userId });
      const relay = new OutboxRelay(runtime, queue);
      assert.equal(await relay.dispatchPending(), 1);
      await connection.call("FLUSHDB");
      assert.ok((await relay.recoverFromPostgres()) >= 1);
      assert.ok(
        (await queue.getWaiting()).some((job) => job.data.id === event.id),
      );
      assert.equal(
        (await runtime.dispatchState(event.id))?.dispatches.length,
        2,
      );
    } finally {
      await queue.close();
      await connection.quit();
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "a replay after database effect before BullMQ acknowledgement does not duplicate it",
  { skip: !databaseUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS runtime_test_effects(event_id uuid PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const event = await createEvent({ pool, userId });
      const effect = async (client: {
        query: (...args: unknown[]) => Promise<unknown>;
      }) => {
        await client.query(
          "INSERT INTO runtime_test_effects(event_id) VALUES ($1)",
          [event.id],
        );
      };
      assert.equal(
        (await runtime.runIdempotentConsumer("test.db-effect", event, effect))
          .state,
        "completed",
      );
      // Simulates a process crash after PostgreSQL committed but before BullMQ could ACK.
      assert.equal(
        (await runtime.runIdempotentConsumer("test.db-effect", event, effect))
          .state,
        "skipped",
      );
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_test_effects WHERE event_id = $1",
        [event.id],
      );
      assert.equal(count.rows[0]?.count, "1");
      assert.equal(
        (await runtime.getReceipt("test.db-effect", event.id))?.state,
        "completed",
      );
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "two workers share one durable receipt and apply one effect",
  { skip: !databaseUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS runtime_test_effects(event_id uuid PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const event = await createEvent({ pool, userId });
      const effect = async (client: {
        query: (...args: unknown[]) => Promise<unknown>;
      }) => {
        await client.query("SELECT pg_sleep(0.05)");
        await client.query(
          "INSERT INTO runtime_test_effects(event_id) VALUES ($1)",
          [event.id],
        );
      };
      const results = await Promise.all([
        runtime.runIdempotentConsumer("test.concurrent", event, effect),
        runtime.runIdempotentConsumer("test.concurrent", event, effect),
      ]);
      assert.deepEqual(results.map((result) => result.state).sort(), [
        "completed",
        "skipped",
      ]);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_test_effects WHERE event_id = $1",
        [event.id],
      );
      assert.equal(count.rows[0]?.count, "1");
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "consumer reloads canonical Postgres event and rejects unregistered future features",
  { skip: !databaseUrl },
  async () => {
    const { pool, runtime, userId } = await setup();
    try {
      const event = await createEvent({ pool, userId });
      const registry = new ConsumerRegistry(runtime);
      await assert.rejects(
        registry.consume({
          ...event,
          userId: randomUUID(),
          payload: { sourceItemId: "changed", sourceItemRevisionId: "changed" },
        }),
        /No registered consumer/,
      );
      let observedUserId = "";
      registry.register({
        name: "test.canonical",
        eventTypes: ["source.item.revision.created.v1"],
        async handle(canonical) {
          observedUserId = canonical.userId;
        },
      });
      await registry.consume({ ...event, userId: randomUUID() });
      assert.equal(observedUserId, userId);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "authorized ObjectStorage validates metadata and cleans a new orphan after DB failure",
  { skip: !databaseUrl },
  async () => {
    const { pool, userId } = await setup();
    let userB: string | undefined;
    try {
      userB = randomUUID();
      await new UserRepository(pool).create({
        id: userB,
        emailNormalized: `${userB}@example.test`,
        passwordHash: "synthetic-password-hash",
        timeZone: "America/Bogota",
      });
      const objects = new MemoryObjectStorage();
      const catalog = new SourceRepository(pool);
      const storage = new AuthorizedBlobStorage(objects, catalog);
      const blobId = randomUUID();
      const bytes = new TextEncoder().encode("synthetic object bytes");
      await storage.write({ userId, blobId, bytes, contentType: "text/plain" });
      assert.deepEqual(await storage.read(userId, blobId), bytes);
      assert.equal(await storage.read(userB, blobId), null);
      assert.equal(objects.objects.size, 1);

      // Same user/revision is idempotent and leaves the original intact.
      await storage.write({ userId, blobId, bytes, contentType: "text/plain" });
      assert.equal(objects.objects.size, 1);
      // A cross-owner DB primary-key failure compensates only the new owner's key.
      await assert.rejects(
        storage.write({
          userId: userB,
          blobId,
          bytes,
          contentType: "text/plain",
        }),
      );
      assert.equal(objects.objects.size, 1);
      assert.deepEqual(await storage.read(userId, blobId), bytes);
    } finally {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        [userId, ...(userB ? [userB] : [])],
      ]);
      await pool.end();
    }
  },
);

test(
  "ObjectStorage serializes concurrent writers with a single database client",
  { skip: !databaseUrl },
  async () => {
    const { pool, userId } = await setup(1);
    try {
      const storage = new AuthorizedBlobStorage(
        new MemoryObjectStorage(),
        new SourceRepository(pool),
      );
      const blobId = randomUUID();
      const bytes = new TextEncoder().encode("single-client synthetic object");
      await Promise.race([
        Promise.all([
          storage.write({ userId, blobId, bytes, contentType: "text/plain" }),
          storage.write({ userId, blobId, bytes, contentType: "text/plain" }),
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("blob lock timed out")), 1_000),
        ),
      ]);
      assert.deepEqual(await storage.read(userId, blobId), bytes);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "S3 ObjectStorage persists owner-authorized bytes through MinIO",
  { skip: !databaseUrl || !objectStorageEndpoint || !objectStorageBucket },
  async () => {
    const { pool, userId } = await setup();
    try {
      const objects = new S3ObjectStorage({
        endpoint: objectStorageEndpoint!,
        bucket: objectStorageBucket!,
        accessKeyId: process.env.TEST_OBJECT_STORAGE_ACCESS_KEY,
        secretAccessKey: process.env.TEST_OBJECT_STORAGE_SECRET_KEY,
      });
      await objects.ensureBucket();
      const storage = new AuthorizedBlobStorage(
        objects,
        new SourceRepository(pool),
      );
      const blobId = randomUUID();
      const bytes = new TextEncoder().encode("synthetic MinIO object");
      await storage.write({ userId, blobId, bytes, contentType: "text/plain" });
      assert.deepEqual(await storage.read(userId, blobId), bytes);
      await objects.remove(`users/${userId}/blobs/${blobId}`);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);
