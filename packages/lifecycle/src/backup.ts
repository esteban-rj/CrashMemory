import {
  createDecipheriv,
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pool } from "pg";
import type { ObjectStorage } from "@crashmemory/runtime";
import {
  EncryptedFileDeletionJournal,
  LifecycleService,
  type DeletionJournal,
} from "./index.ts";

const format = "crashmemory-lifecycle-backup-v1";
const scopes = new Set([
  "account",
  "gmail_connection",
  "gmail_disconnect",
  "gmail_message",
  "obligation",
  "telegram_link",
]);

export interface PostgresTools {
  /** PostgreSQL tools from the named container; localhost is its own DB port. */
  container?: string;
  dockerContext?: string;
}

async function runPgTool(
  tool: "pg_dump" | "pg_restore",
  args: string[],
  databaseUrl: string,
  options: PostgresTools,
  input?: Buffer,
): Promise<Buffer> {
  const url = new URL(databaseUrl);
  if (options.container) {
    url.hostname = "127.0.0.1";
    url.port = "5432";
  }
  const command = options.container ? "docker" : tool;
  const commandArgs = options.container
    ? [
        ...(options.dockerContext ? ["--context", options.dockerContext] : []),
        "exec",
        "-i",
        options.container,
        tool,
        ...args,
        "--dbname",
        url.toString(),
      ]
    : [...args, "--dbname", databaseUrl];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new Error(
              `${tool} failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(0, 2000)}`,
            ),
          ),
    );
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

type ArchivePayload = {
  format: typeof format;
  createdAt: string;
  postgresDump: string;
  postgresSha256: string;
  journalBytes: number;
  journalSha256: string;
  objects: Array<{
    key: string;
    sha256: string;
    contentType: string;
    bytes: string;
  }>;
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
  if (content && !content.endsWith("\n"))
    throw new Error("Lifecycle journal has a partial final line");
  const decoded = content
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      if (!line) throw new Error("Lifecycle journal has an empty line");
      const record = JSON.parse(line) as {
        v: number;
        iv: string;
        tag: string;
        data: string;
      };
      if (
        record.v !== 1 ||
        typeof record.iv !== "string" ||
        typeof record.tag !== "string" ||
        typeof record.data !== "string"
      )
        throw new Error("Unsupported lifecycle journal version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const entry = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(record.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as Record<string, unknown>;
      return entry;
    });
  const header = decoded.shift();
  if (
    header?.kind !== "lifecycle_journal_header" ||
    typeof header.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(header.id)
  )
    throw new Error("Lifecycle journal identity is missing");
  for (const entry of decoded) validateJournalEntry(entry);
  return decoded;
}

function validateJournalEntry(entry: Record<string, unknown>): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(String(entry.userId ?? "")) ||
    !scopes.has(String(entry.scope ?? "")) ||
    typeof entry.tombstoneKey !== "string" ||
    entry.tombstoneKey.length < 1 ||
    entry.tombstoneKey.length > 1024 ||
    typeof entry.reason !== "string" ||
    entry.reason.length < 1 ||
    entry.reason.length > 100
  )
    throw new Error("Lifecycle journal entry is invalid");
  if (
    ["gmail_connection", "gmail_disconnect"].includes(String(entry.scope)) &&
    !uuid.test(String(entry.sourceConnectionId ?? ""))
  )
    throw new Error("Lifecycle journal connection is invalid");
  if (
    entry.scope === "gmail_message" &&
    (typeof entry.externalAccountId !== "string" ||
      !entry.externalAccountId ||
      typeof entry.externalMessageId !== "string" ||
      !entry.externalMessageId)
  )
    throw new Error("Lifecycle journal message is invalid");
  if (
    entry.scope === "gmail_message" &&
    !["source_deleted", "knowledge_deleted"].includes(String(entry.reason))
  )
    throw new Error("Lifecycle journal message reason is invalid");
  if (
    entry.scope === "obligation" &&
    !uuid.test(entry.tombstoneKey.split(":").at(-1) ?? "")
  )
    throw new Error("Lifecycle journal obligation is invalid");
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
    journalKeyBase64: string;
    postgresTools?: PostgresTools;
  }): Promise<{ objectCount: number }> {
    await new EncryptedFileDeletionJournal(
      input.journalPath,
      input.journalKeyBase64,
    ).initialize();
    const journal = await readEncryptedJournal(
      input.journalPath,
      input.journalKeyBase64,
    );
    const journalBytes = await readFile(input.journalPath);
    const journalKeys = new Set(
      journal.map((entry) => String(entry.tombstoneKey)),
    );
    const barriers = await this.pool.query<{ tombstone_key: string }>(
      "SELECT tombstone_key FROM lifecycle_tombstones",
    );
    if (barriers.rows.some((row) => !journalKeys.has(row.tombstone_key)))
      throw new Error(
        "Current journal does not cover PostgreSQL deletion barriers",
      );
    const dump = await runPgTool(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--exclude-table-data=lifecycle_tombstones",
        "--exclude-table-data=lifecycle_object_cleanup",
      ],
      input.databaseUrl,
      input.postgresTools ?? {},
    );
    const rows = await this.pool.query<{
      storage_key: string;
      content_sha256: string;
      content_type: string;
      byte_size: number;
    }>(
      "SELECT storage_key, content_sha256, content_type, byte_size FROM blobs ORDER BY storage_key",
    );
    const objects = await Promise.all(
      rows.rows.map(async (row) => {
        const bytes = await this.storage.get(row.storage_key);
        if (
          digest(bytes) !== row.content_sha256 ||
          bytes.byteLength !== Number(row.byte_size)
        )
          throw new Error("Object hash does not match PostgreSQL catalog");
        return {
          key: row.storage_key,
          sha256: row.content_sha256,
          contentType: row.content_type,
          bytes: Buffer.from(bytes).toString("base64"),
        };
      }),
    );
    const payload: ArchivePayload = {
      format,
      createdAt: new Date().toISOString(),
      postgresDump: dump.toString("base64"),
      postgresSha256: digest(dump),
      journalBytes: journalBytes.length,
      journalSha256: digest(journalBytes),
      objects,
    };
    const key = keyFromBase64(input.encryptionKeyBase64);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const output = JSON.stringify({
      format,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    });
    const temporary = `${input.outputPath}.partial-${process.pid}`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(output);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, input.outputPath);
    const directory = await open(dirname(input.outputPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { objectCount: objects.length };
  }

  async restore(input: {
    databaseUrl: string;
    archivePath: string;
    encryptionKeyBase64: string;
    journalPath: string;
    journalKeyBase64: string;
    postgresTools?: PostgresTools;
  }): Promise<{ restoredObjects: number; replayedDeletes: number }> {
    // A missing, partial or unauthentic current journal fails before touching
    // either destination. An old archive is never an authority for deletions.
    const journal = await readEncryptedJournal(
      input.journalPath,
      input.journalKeyBase64,
    );
    const currentJournal = await readFile(input.journalPath);
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
    if (
      payload.format !== format ||
      !Array.isArray(payload.objects) ||
      typeof payload.postgresDump !== "string" ||
      typeof payload.postgresSha256 !== "string"
    )
      throw new Error("Backup payload is invalid");
    if (
      !Number.isSafeInteger(payload.journalBytes) ||
      payload.journalBytes < 0 ||
      typeof payload.journalSha256 !== "string" ||
      currentJournal.length < payload.journalBytes ||
      digest(currentJournal.subarray(0, payload.journalBytes)) !==
        payload.journalSha256
    )
      throw new Error("Current journal does not extend the backup journal");
    const dump = Buffer.from(payload.postgresDump, "base64");
    if (digest(dump) !== payload.postgresSha256)
      throw new Error("Backup PostgreSQL hash is invalid");
    const seen = new Set<string>();
    for (const object of payload.objects) {
      if (
        !object ||
        typeof object.key !== "string" ||
        !/^users\/[0-9a-f-]+\/blobs\/[0-9a-f-]+$/i.test(object.key) ||
        seen.has(object.key) ||
        typeof object.sha256 !== "string" ||
        typeof object.bytes !== "string" ||
        typeof object.contentType !== "string" ||
        digest(Buffer.from(object.bytes, "base64")) !== object.sha256
      )
        throw new Error("Backup object catalog is invalid");
      seen.add(object.key);
    }
    const existing = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')`,
    );
    if (Number(existing.rows[0]?.count ?? 0) !== 0)
      throw new Error("Restore requires a schema-empty PostgreSQL database");
    if (!(await this.storage.isEmpty()))
      throw new Error("Restore requires an empty object bucket");
    await runPgTool(
      "pg_restore",
      ["--no-owner", "--no-acl", "--exit-on-error", "--single-transaction"],
      input.databaseUrl,
      input.postgresTools ?? {},
      dump,
    );
    for (const object of payload.objects) {
      const bytes = Buffer.from(object.bytes, "base64");
      await this.storage.putIfAbsent(object.key, bytes, object.contentType);
    }
    const replayedDeletes = await this.replayJournal(journal);
    return { restoredObjects: payload.objects.length, replayedDeletes };
  }

  private async replayJournal(
    entries: Array<Record<string, unknown>>,
  ): Promise<number> {
    const journal: DeletionJournal = { append: async () => undefined };
    const service = new LifecycleService(this.pool, this.storage, journal);
    let applied = 0;
    for (const entry of entries) {
      validateJournalEntry(entry);
      const userId = String(entry.userId);
      const scope = String(entry.scope);
      // Persist every barrier, including targets created and deleted after
      // the archive. A missing row cannot justify dropping a delete intent.
      await this.pool.query(
        `INSERT INTO lifecycle_tombstones(id,tombstone_key,user_id,scope,provider,external_account_id,source_connection_id,external_message_id,reason)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tombstone_key) DO NOTHING`,
        [
          entry.tombstoneKey,
          userId,
          scope,
          entry.provider ?? null,
          entry.externalAccountId ?? null,
          entry.sourceConnectionId ?? null,
          entry.externalMessageId ?? null,
          entry.reason,
        ],
      );
      try {
        if (scope === "account") await service.deleteAccount({ userId });
        else if (scope === "gmail_disconnect")
          await service.disconnectGmail({
            userId,
            connectionId: String(entry.sourceConnectionId),
          });
        else if (scope === "gmail_connection")
          await service.deleteSourceConnection({
            userId,
            connectionId: String(entry.sourceConnectionId),
          });
        else if (
          scope === "gmail_message" &&
          entry.reason === "source_deleted"
        ) {
          const connection = await this.pool.query<{ id: string }>(
            `SELECT id FROM source_connections WHERE user_id=$1 AND provider='gmail'
             AND external_account_id=$2 ORDER BY created_at LIMIT 1`,
            [userId, entry.externalAccountId],
          );
          if (connection.rows[0])
            await service.deleteSourceItem({
              userId,
              connectionId: connection.rows[0].id,
              externalMessageId: String(entry.externalMessageId),
            });
        } else if (scope === "obligation")
          await service.deleteObligation({
            userId,
            obligationId: String(entry.tombstoneKey).split(":").at(-1)!,
          });
        else if (scope === "telegram_link") {
          const exists = await this.pool.query(
            "SELECT 1 FROM users WHERE id=$1",
            [userId],
          );
          if (exists.rowCount) await service.unlinkTelegram({ userId });
        }
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
