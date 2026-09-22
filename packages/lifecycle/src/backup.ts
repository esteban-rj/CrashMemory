import {
  createDecipheriv,
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import type { ObjectStorage } from "@crashmemory/runtime";
import {
  EncryptedFileDeletionJournal,
  LifecycleService,
  type DeletionJournal,
} from "./index.ts";

const execute = promisify(execFile);
const format = "crashmemory-lifecycle-backup-v1";

type ArchivePayload = {
  format: typeof format;
  createdAt: string;
  postgresDump: string;
  objects: Array<{ key: string; sha256: string; bytes: string }>;
};

function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error("Backup encryption key must be 32 bytes base64");
  return key;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readEncryptedJournal(
  path: string,
  keyBase64: string,
): Promise<Array<Record<string, unknown>>> {
  const key = keyFromBase64(keyBase64);
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line) as {
        v: number;
        iv: string;
        tag: string;
        data: string;
      };
      if (record.v !== 1)
        throw new Error("Unsupported lifecycle journal version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(record.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as Record<string, unknown>;
    });
}

export class LifecycleBackupService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: ObjectStorage,
  ) {}

  async backup(input: {
    databaseUrl: string;
    outputPath: string;
    encryptionKeyBase64: string;
    journalPath: string;
  }): Promise<{ objectCount: number }> {
    // Readability is an explicit precondition: the live journal is retained
    // outside the archive and restored/replayed from its latest copy.
    await readFile(input.journalPath);
    const work = await mkdtemp(join(tmpdir(), "crashmemory-backup-"));
    const dumpPath = join(work, "postgres.dump");
    try {
      await execute("pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--exclude-table-data=lifecycle_tombstones",
        "--exclude-table-data=lifecycle_object_cleanup",
        "--file",
        dumpPath,
        input.databaseUrl,
      ]);
      const rows = await this.pool.query<{
        storage_key: string;
        content_sha256: string;
      }>("SELECT storage_key, content_sha256 FROM blobs ORDER BY storage_key");
      const objects = await Promise.all(
        rows.rows.map(async (row) => {
          const bytes = await this.storage.get(row.storage_key);
          if (digest(bytes) !== row.content_sha256)
            throw new Error("Object hash does not match PostgreSQL catalog");
          return {
            key: row.storage_key,
            sha256: row.content_sha256,
            bytes: Buffer.from(bytes).toString("base64"),
          };
        }),
      );
      const payload: ArchivePayload = {
        format,
        createdAt: new Date().toISOString(),
        postgresDump: (await readFile(dumpPath)).toString("base64"),
        objects,
      };
      const key = keyFromBase64(input.encryptionKeyBase64);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      await writeFile(
        input.outputPath,
        JSON.stringify({
          format,
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: encrypted.toString("base64"),
        }),
        { mode: 0o600 },
      );
      return { objectCount: objects.length };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async restore(input: {
    databaseUrl: string;
    archivePath: string;
    encryptionKeyBase64: string;
    journalPath: string;
    journalKeyBase64: string;
  }): Promise<{ restoredObjects: number; replayedDeletes: number }> {
    const envelope = JSON.parse(await readFile(input.archivePath, "utf8")) as {
      format: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    if (envelope.format !== format)
      throw new Error("Unsupported backup archive");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFromBase64(input.encryptionKeyBase64),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as ArchivePayload;
    if (payload.format !== format) throw new Error("Backup payload is invalid");
    const work = await mkdtemp(join(tmpdir(), "crashmemory-restore-"));
    try {
      const dumpPath = join(work, "postgres.dump");
      await writeFile(dumpPath, Buffer.from(payload.postgresDump, "base64"), {
        mode: 0o600,
      });
      await execute("pg_restore", [
        "--no-owner",
        "--no-acl",
        "--single-transaction",
        "--dbname",
        input.databaseUrl,
        dumpPath,
      ]);
      for (const object of payload.objects) {
        const bytes = Buffer.from(object.bytes, "base64");
        if (digest(bytes) !== object.sha256)
          throw new Error("Backup object hash is invalid");
        await this.storage.putIfAbsent(
          object.key,
          bytes,
          "application/octet-stream",
        );
      }
      const journal = await readEncryptedJournal(
        input.journalPath,
        input.journalKeyBase64,
      );
      const replayedDeletes = await this.replayJournal(journal);
      return { restoredObjects: payload.objects.length, replayedDeletes };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async replayJournal(
    entries: Array<Record<string, unknown>>,
  ): Promise<number> {
    const journal: DeletionJournal = { append: async () => undefined };
    const service = new LifecycleService(this.pool, this.storage, journal);
    let applied = 0;
    for (const entry of entries) {
      const userId = typeof entry.userId === "string" ? entry.userId : null;
      if (!userId || typeof entry.scope !== "string") continue;
      try {
        if (entry.scope === "account") await service.deleteAccount({ userId });
        else if (
          entry.scope === "gmail_connection" &&
          typeof entry.sourceConnectionId === "string"
        )
          await service.deleteSourceConnection({
            userId,
            connectionId: entry.sourceConnectionId,
            actorSessionId: undefined as never,
          });
        else if (
          entry.scope === "gmail_message" &&
          typeof entry.sourceConnectionId === "string" &&
          typeof entry.externalMessageId === "string"
        )
          await service.deleteSourceItem({
            userId,
            connectionId: entry.sourceConnectionId,
            externalMessageId: entry.externalMessageId,
            actorSessionId: undefined as never,
          });
        else if (
          entry.scope === "obligation" &&
          typeof entry.tombstoneKey === "string"
        ) {
          const obligationId = entry.tombstoneKey.split(":").at(-1);
          if (obligationId)
            await service.deleteObligation({
              userId,
              obligationId,
              actorSessionId: undefined as never,
            });
        } else continue;
        applied += 1;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "LifecycleNotFoundError"
        )
          throw error;
      }
    }
    return applied;
  }
}
