import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, migrate } from "@crashmemory/db";
import { MemoryObjectStorage } from "@crashmemory/runtime";
import {
  EncryptedFileDeletionJournal,
  LifecycleJournalRequiredError,
  LifecycleService,
  readEncryptedJournal,
} from "../src/index.ts";

test("encrypted lifecycle journal is fsync-safe append-only and does not expose source identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crashmemory-v09-"));
  const path = join(directory, "journal.log");
  const journal = new EncryptedFileDeletionJournal(
    path,
    Buffer.alloc(32, 7).toString("base64"),
  );
  await journal.append({
    scope: "gmail_message",
    externalMessageId: "synthetic-message-42",
  });
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /synthetic-message-42/);
  assert.match(raw, /"iv"/);
  assert.match(raw, /"tag"/);
});

test("concurrent initialization and append across instances writes one header and eight valid entries", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "crashmemory-v09-journal-race-"),
  );
  const path = join(directory, "journal.log");
  const key = Buffer.alloc(32, 9).toString("base64");
  const journals = [
    new EncryptedFileDeletionJournal(path, key),
    new EncryptedFileDeletionJournal(path, key),
  ];
  const entries = Array.from({ length: 8 }, (_, index) => {
    const userId = randomUUID();
    return {
      userId,
      scope: "account",
      tombstoneKey: `${userId}:account`,
      reason: "account_deleted",
      index,
    };
  });
  await Promise.all([
    journals[0]!.initialize(),
    journals[1]!.initialize(),
    ...entries.map((entry, index) => journals[index % 2]!.append(entry)),
  ]);
  const decoded = await readEncryptedJournal(path, key);
  assert.equal(decoded.length, 8);
  assert.deepEqual(
    new Set(decoded.map((entry) => entry.tombstoneKey)),
    new Set(entries.map((entry) => entry.tombstoneKey)),
  );
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 9);
});

test("destructive lifecycle calls fail before database work without a durable journal", async () => {
  const service = new LifecycleService({} as never);
  await assert.rejects(
    service.disconnectGmail({
      userId: "00000000-0000-0000-0000-000000000001",
      connectionId: "00000000-0000-0000-0000-000000000002",
      actorSessionId: "00000000-0000-0000-0000-000000000003",
    }),
    LifecycleJournalRequiredError,
  );
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "source deletion fences replay, removes originals and drops unsupported knowledge",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const ids = Array.from({ length: 9 }, () => randomUUID());
    const [
      userId,
      sessionId,
      connectionId,
      itemId,
      blobId,
      revisionId,
      evidenceId,
      obligationId,
      versionId,
    ] = ids;
    const key = `users/${userId}/blobs/${blobId}`;
    const storage = new MemoryObjectStorage();
    storage.objects.set(key, new Uint8Array([1, 2, 3]));
    try {
      await pool.query(
        "INSERT INTO users(id,email_normalized,password_hash,time_zone) VALUES ($1,$2,'hash','America/Bogota')",
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        "INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
        [sessionId, userId, "d".repeat(64), "e".repeat(64)],
      );
      await pool.query(
        "INSERT INTO source_connections(id,user_id,provider,external_account_id,state) VALUES ($1,$2,'gmail','source@example.test','active')",
        [connectionId, userId],
      );
      await pool.query(
        "INSERT INTO blobs(id,user_id,storage_key,content_type,byte_size,content_sha256) VALUES ($1,$2,$3,'message/rfc822',3,$4)",
        [blobId, userId, key, "a".repeat(64)],
      );
      await pool.query(
        "INSERT INTO source_items(id,user_id,source_connection_id,external_id) VALUES ($1,$2,$3,'message-42')",
        [itemId, userId, connectionId],
      );
      await pool.query(
        "INSERT INTO source_item_revisions(id,user_id,source_item_id,revision,original_blob_id,content_sha256,observed_at) VALUES ($1,$2,$3,1,$4,$5,now())",
        [revisionId, userId, itemId, blobId, "b".repeat(64)],
      );
      await pool.query(
        "INSERT INTO evidence(id,user_id,source_item_revision_id,kind,start_offset,end_offset,quote,content_sha256) VALUES ($1,$2,$3,'email_body_fragment',0,1,'x',$4)",
        [evidenceId, userId, revisionId, "c".repeat(64)],
      );
      await pool.query(
        "INSERT INTO obligations(id,user_id,state) VALUES ($1,$2,'confirmed')",
        [obligationId, userId],
      );
      await pool.query(
        "INSERT INTO obligation_versions(id,user_id,obligation_id,revision,title) VALUES ($1,$2,$3,1,'Synthetic')",
        [versionId, userId, obligationId],
      );
      await pool.query(
        "UPDATE obligations SET current_version_id=$1 WHERE id=$2",
        [versionId, obligationId],
      );
      await pool.query(
        "INSERT INTO obligation_version_evidence(user_id,obligation_version_id,evidence_id) VALUES ($1,$2,$3)",
        [userId, versionId, evidenceId],
      );
      const journal: Array<Record<string, unknown>> = [];
      const service = new LifecycleService(pool, storage, {
        append: async (entry) => {
          journal.push(entry);
        },
      });
      const writerLock = await pool.connect();
      await writerLock.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 1))",
        [`lifecycle:user:${userId}`],
      );
      let finished = false;
      const deletion = service.deleteSourceConnection({
        userId,
        connectionId,
        actorSessionId: sessionId,
      });
      void deletion.then(() => {
        finished = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(
          finished,
          false,
          "deletion must wait for the in-flight writer lock",
        );
      } finally {
        await writerLock.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 1))",
          [`lifecycle:user:${userId}`],
        );
        writerLock.release();
      }
      const result = await deletion;
      assert.deepEqual(result, {
        deletedSourceItems: 1,
        deletedObligations: 1,
        cancelledReminders: 0,
        pendingObjectCleanup: 0,
      });
      assert.equal(
        (
          await pool.query("SELECT 1 FROM obligations WHERE id=$1", [
            obligationId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query("SELECT 1 FROM source_connections WHERE id=$1", [
            connectionId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(storage.objects.has(key), false);
      assert.ok(journal.some((entry) => entry.scope === "gmail_message"));
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [userId]);
      await pool.end();
    }
  },
);

test(
  "durable object cleanup retries after account deletion and protects live blobs",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userId = randomUUID(),
      blobId = randomUUID(),
      liveUser = randomUUID(),
      liveBlob = randomUUID();
    const key = `users/${userId}/blobs/${blobId}`;
    const liveKey = `users/${liveUser}/blobs/${liveBlob}`;
    class FlakyStorage extends MemoryObjectStorage {
      fails = 1;
      override async remove(storageKey: string): Promise<void> {
        if (this.fails-- > 0) throw new Error("synthetic_minio_outage");
        await super.remove(storageKey);
      }
    }
    const storage = new FlakyStorage();
    try {
      for (const id of [userId, liveUser])
        await pool.query(
          "INSERT INTO users(id,email_normalized,password_hash,time_zone) VALUES ($1,$2,'synthetic','America/Bogota')",
          [id, `${id}@example.test`],
        );
      for (const [id, owner, storageKey] of [
        [blobId, userId, key],
        [liveBlob, liveUser, liveKey],
      ]) {
        storage.objects.set(storageKey!, new Uint8Array([1]));
        await pool.query(
          "INSERT INTO blobs(id,user_id,storage_key,content_type,byte_size,content_sha256) VALUES ($1,$2,$3,'text/plain',1,$4)",
          [id, owner, storageKey, "a".repeat(64)],
        );
      }
      const journal = new EncryptedFileDeletionJournal(
        join(
          await mkdtemp(join(tmpdir(), "crashmemory-v09-cleanup-")),
          "journal",
        ),
        Buffer.alloc(32, 5).toString("base64"),
      );
      assert.equal(
        (
          await new LifecycleService(pool, storage, journal).deleteAccount({
            userId,
          })
        ).pendingObjectCleanup,
        1,
      );
      assert.equal(storage.objects.has(key), true);
      await pool.query(
        "INSERT INTO lifecycle_object_cleanup(storage_key,user_id) VALUES ($1,$2)",
        [liveKey, liveUser],
      );
      const retried = await new LifecycleService(
        pool,
        storage,
      ).drainObjectCleanup();
      assert.deepEqual(retried, { removed: 1, pending: 1, skippedLive: 1 });
      assert.equal(storage.objects.has(key), false);
      assert.equal(storage.objects.has(liveKey), true);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM lifecycle_object_cleanup WHERE storage_key=$1",
            [key],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        "DELETE FROM lifecycle_object_cleanup WHERE storage_key=$1",
        [liveKey],
      );
      await pool.query("DELETE FROM users WHERE id=$1", [liveUser]);
      await pool.end();
    }
  },
);
