import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import { Redis } from "ioredis";
import {
  DurableRuntimeRepository,
  type DispatchAttempt,
} from "@crashmemory/db";
import { type OutboxEvent } from "@crashmemory/contracts";
import type { PoolClient } from "pg";

export const DEFAULT_QUEUE_NAME = "crashmemory-outbox-v1";
type OutboxQueue = Queue<OutboxEvent, unknown, string>;
type OutboxWorker = Worker<OutboxEvent, unknown, string>;

export class RuntimeMetrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.counters));
  }
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createOutboxQueue(
  redisUrl: string,
  queueName = DEFAULT_QUEUE_NAME,
): {
  queue: OutboxQueue;
  connection: Redis;
} {
  const connection = createRedisConnection(redisUrl);
  return {
    queue: new Queue<OutboxEvent, unknown, string>(queueName, {
      connection,
    }),
    connection,
  };
}

export class OutboxRelay {
  constructor(
    private readonly repository: DurableRuntimeRepository,
    private readonly queue: OutboxQueue,
    private readonly metrics = new RuntimeMetrics(),
  ) {}

  async dispatchPending(limit = 100): Promise<number> {
    return this.dispatch(await this.repository.claimForDispatch(limit));
  }

  /** Rebuilds Redis jobs from PostgreSQL after restart, loss or flush. */
  async recoverFromPostgres(limit = 1_000): Promise<number> {
    let cursor: { createdAt: string; eventId: string } | undefined;
    let delivered = 0;
    do {
      const batch = await this.repository.claimForRecovery(limit, cursor);
      delivered += await this.dispatch(batch.attempts);
      cursor = batch.nextCursor ?? undefined;
    } while (cursor);
    return delivered;
  }

  private async dispatch(attempts: DispatchAttempt[]): Promise<number> {
    let delivered = 0;
    for (const attempt of attempts) {
      try {
        const options: JobsOptions = {
          jobId: attempt.jobId,
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
          // Completion is stored in PostgreSQL receipts. Removing the Redis
          // copy permits a later recovery pass to replay safely.
          removeOnComplete: true,
          removeOnFail: false,
        };
        await this.queue.add("outbox-event", attempt.event, options);
        await this.repository.markEnqueued(attempt);
        this.metrics.increment("outbox.dispatch.enqueued");
        delivered += 1;
      } catch (error) {
        await this.repository.markDispatchFailed(attempt, error);
        this.metrics.increment("outbox.dispatch.failed");
      }
    }
    return delivered;
  }

  getMetrics(): Readonly<Record<string, number>> {
    return this.metrics.snapshot();
  }
}

export interface RegisteredConsumer {
  name: string;
  eventTypes: readonly OutboxEvent["type"][];
  /** Database-only effect. It shares the receipt transaction. */
  handle(event: OutboxEvent, client: PoolClient): Promise<void>;
}

/**
 * Contract for a future provider such as Telegram. `prepareAttempt` persists
 * the intent before any HTTP call; `deliver` runs outside a DB transaction;
 * timeouts or ambiguous responses resolve as `unknown`. This runtime does not
 * claim exactly-once delivery to external systems.
 */
export interface ExternalEffectContract<Attempt, Request> {
  prepareAttempt(): Promise<Attempt>;
  deliver(request: Request): Promise<"sent" | "failed" | "unknown">;
  resolveAttempt(
    attempt: Attempt,
    outcome: "sent" | "failed" | "unknown",
  ): Promise<void>;
}

export class UnregisteredEventConsumerError extends Error {
  constructor(eventType: string) {
    super(`No registered consumer for ${eventType}`);
    this.name = "UnregisteredEventConsumerError";
  }
}

/**
 * A registry deliberately rejects missing handlers. V03 must not acknowledge
 * future V05/V06/V07 events with a placeholder handler.
 */
export class ConsumerRegistry {
  private readonly byType = new Map<string, RegisteredConsumer[]>();

  constructor(
    private readonly repository: DurableRuntimeRepository,
    private readonly metrics = new RuntimeMetrics(),
  ) {}

  register(consumer: RegisteredConsumer): void {
    if (
      !consumer.name ||
      typeof consumer.handle !== "function" ||
      consumer.eventTypes.length === 0
    ) {
      throw new Error("A consumer needs a name, event type and implementation");
    }
    for (const eventType of consumer.eventTypes) {
      const current = this.byType.get(eventType) ?? [];
      if (current.some((entry) => entry.name === consumer.name)) {
        throw new Error(
          `Consumer ${consumer.name} is already registered for ${eventType}`,
        );
      }
      current.push(consumer);
      this.byType.set(eventType, current);
    }
  }

  async consume(rawEvent: unknown): Promise<void> {
    if (
      !rawEvent ||
      typeof rawEvent !== "object" ||
      !("id" in rawEvent) ||
      typeof (rawEvent as { id: unknown }).id !== "string"
    ) {
      throw new Error("BullMQ job has no event identifier");
    }
    // Redis is an untrusted, recoverable transport. Only the event ID comes
    // from the job; every other field is read and validated from PostgreSQL.
    const eventId = (rawEvent as { id: string }).id;
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new Error(`Outbox event ${eventId} no longer exists`);
    const consumers = this.byType.get(event.type);
    if (!consumers || consumers.length === 0) {
      this.metrics.increment("consumer.unregistered");
      throw new UnregisteredEventConsumerError(event.type);
    }
    for (const consumer of consumers) {
      const receipt = await this.repository.runIdempotentConsumer(
        consumer.name,
        event,
        (client) => consumer.handle(event, client),
      );
      this.metrics.increment(`consumer.${receipt.state}`);
    }
  }

  getMetrics(): Readonly<Record<string, number>> {
    return this.metrics.snapshot();
  }
}

export function startOutboxWorker(input: {
  redisUrl: string;
  queueName?: string;
  registry: ConsumerRegistry;
  concurrency?: number;
}): { worker: OutboxWorker; connection: Redis } {
  const connection = createRedisConnection(input.redisUrl);
  const processor: Processor<OutboxEvent, unknown, string> = async (job) =>
    input.registry.consume(job.data);
  const worker: OutboxWorker = new Worker<OutboxEvent, unknown, string>(
    input.queueName ?? DEFAULT_QUEUE_NAME,
    processor,
    { connection, concurrency: input.concurrency ?? 4 },
  );
  return { worker, connection };
}

export interface ObjectStorage {
  /** Returns false without overwriting when the key already exists. */
  putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<boolean>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

export interface BlobCatalog {
  withBlobWriteLock<T>(
    blobId: string,
    operation: (catalog: BlobCatalog) => Promise<T>,
  ): Promise<T>;
  createBlob(input: {
    id: string;
    userId: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    contentSha256: string;
  }): Promise<void>;
  getBlob(userId: string, id: string): Promise<Record<string, unknown> | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function blobStorageKey(userId: string, blobId: string): string {
  if (!uuidPattern.test(userId) || !uuidPattern.test(blobId)) {
    throw new Error("Object storage requires UUID user and blob identifiers");
  }
  return `users/${userId}/blobs/${blobId}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeBlobMetadata(
  metadata: Record<string, unknown>,
  userId: string,
  blobId: string,
): {
  storageKey: string;
  byteSize: number;
  contentSha256: string;
  contentType: string;
} {
  const storageKey = metadata.storage_key;
  const rawByteSize = metadata.byte_size;
  const byteSize =
    typeof rawByteSize === "number"
      ? rawByteSize
      : typeof rawByteSize === "string" && /^\d+$/.test(rawByteSize)
        ? Number(rawByteSize)
        : NaN;
  if (
    storageKey !== blobStorageKey(userId, blobId) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    typeof metadata.content_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.content_sha256) ||
    typeof metadata.content_type !== "string"
  ) {
    throw new Error("Blob metadata violates the owner storage namespace");
  }
  return {
    storageKey,
    byteSize,
    contentSha256: metadata.content_sha256,
    contentType: metadata.content_type,
  };
}

export class ObjectStorageCompensationError extends Error {
  constructor(
    readonly original: unknown,
    readonly cleanup: unknown,
  ) {
    super("Database write failed and orphaned object cleanup also failed");
    this.name = "ObjectStorageCompensationError";
  }
}

function isDeterministicDatabaseRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code.startsWith("22") || code.startsWith("23") || code.startsWith("40"))
  );
}

/**
 * Authorization happens against the owner-scoped blob row before read. Writes
 * use a deterministic owner namespace and compensate the object if the DB
 * metadata transaction fails, so an object never becomes evidence by itself.
 */
export class AuthorizedBlobStorage {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly catalog: BlobCatalog,
    private readonly metrics = new RuntimeMetrics(),
  ) {}

  async write(input: {
    userId: string;
    blobId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ storageKey: string; byteSize: number; contentSha256: string }> {
    return this.catalog.withBlobWriteLock(input.blobId, async (catalog) =>
      this.writeLocked(catalog, input),
    );
  }

  private async writeLocked(
    catalog: BlobCatalog,
    input: {
      userId: string;
      blobId: string;
      bytes: Uint8Array;
      contentType: string;
    },
  ): Promise<{ storageKey: string; byteSize: number; contentSha256: string }> {
    const storageKey = blobStorageKey(input.userId, input.blobId);
    const contentSha256 = sha256(input.bytes);
    const existing = await catalog.getBlob(input.userId, input.blobId);
    if (existing) {
      const persisted = normalizeBlobMetadata(
        existing,
        input.userId,
        input.blobId,
      );
      if (
        persisted.byteSize !== input.bytes.byteLength ||
        persisted.contentSha256 !== contentSha256 ||
        persisted.contentType !== input.contentType
      ) {
        throw new Error("Blob ID already belongs to different content");
      }
      this.metrics.increment("object_storage.write.idempotent");
      return { storageKey, byteSize: persisted.byteSize, contentSha256 };
    }
    const createdObject = await this.storage.putIfAbsent(
      storageKey,
      input.bytes,
      input.contentType,
    );
    if (!createdObject) {
      const existingBytes = await this.storage.get(storageKey);
      if (
        sha256(existingBytes) !== contentSha256 ||
        existingBytes.byteLength !== input.bytes.byteLength
      ) {
        throw new Error("Object namespace already contains different content");
      }
    }
    try {
      await catalog.createBlob({
        id: input.blobId,
        userId: input.userId,
        storageKey,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        contentSha256,
      });
      this.metrics.increment("object_storage.write.committed");
      return { storageKey, byteSize: input.bytes.byteLength, contentSha256 };
    } catch (error) {
      // Connection loss can leave the INSERT outcome unknown. Preserve that
      // orphan for a later reconciler rather than deleting an object that may
      // already have durable metadata. Constraint/validation/serialization
      // failures are definitive and can be compensated under the same lock.
      if (createdObject && isDeterministicDatabaseRejection(error)) {
        try {
          await this.storage.remove(storageKey);
          this.metrics.increment("object_storage.orphan.cleaned");
        } catch (cleanup) {
          this.metrics.increment("object_storage.orphan.cleanup_failed");
          throw new ObjectStorageCompensationError(error, cleanup);
        }
      } else if (createdObject)
        this.metrics.increment("object_storage.orphan.pending");
      throw error;
    }
  }

  async read(userId: string, blobId: string): Promise<Uint8Array | null> {
    const metadata = await this.catalog.getBlob(userId, blobId);
    if (!metadata) return null;
    const expectedKey = blobStorageKey(userId, blobId);
    const persisted = normalizeBlobMetadata(metadata, userId, blobId);
    const bytes = await this.storage.get(expectedKey);
    if (
      bytes.byteLength !== persisted.byteSize ||
      sha256(bytes) !== persisted.contentSha256
    ) {
      throw new Error(
        "Object storage bytes do not match durable blob metadata",
      );
    }
    this.metrics.increment("object_storage.read.authorized");
    return bytes;
  }

  getMetrics(): Readonly<Record<string, number>> {
    return this.metrics.snapshot();
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(input: {
    endpoint?: string;
    bucket: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    this.bucket = input.bucket;
    this.client = new S3Client({
      endpoint: input.endpoint,
      region: input.region ?? "us-east-1",
      forcePathStyle: Boolean(input.endpoint),
      credentials:
        input.accessKeyId && input.secretAccessKey
          ? {
              accessKeyId: input.accessKeyId,
              secretAccessKey: input.secretAccessKey,
            }
          : undefined,
    });
  }

  private readonly bucket: string;

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          (error as { name?: string }).name === "BucketAlreadyOwnedByYou"
        )) {
          throw error;
        }
      }
    }
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { name?: string }).name === "PreconditionFailed"
      ) {
        return false;
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("Object storage returned an empty body");
    return result.Body.transformToByteArray();
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();

  async putIfAbsent(key: string, body: Uint8Array): Promise<boolean> {
    if (this.objects.has(key)) return false;
    this.objects.set(key, new Uint8Array(body));
    return true;
  }

  async get(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (!body) throw new Error("Object does not exist");
    return new Uint8Array(body);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
