import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPool, migrate } from "@crashmemory/db";
import { S3ObjectStorage } from "@crashmemory/runtime";
import { PostgresGmailPersistence } from "@crashmemory/gmail/postgres";
import { ReconciliationService } from "@crashmemory/reconciliation";
import {
  EncryptedFileDeletionJournal,
  LifecycleBackupService,
  LifecycleService,
} from "../src/index.ts";

const sourceUrl = process.env.TEST_DATABASE_URL;
const restoreUrl = process.env.TEST_RESTORE_DATABASE_URL;
const endpoint = process.env.TEST_OBJECT_STORAGE_ENDPOINT;
const container = process.env.TEST_PG_CONTAINER;
const accessKeyId = process.env.TEST_OBJECT_STORAGE_ACCESS_KEY;
const secretAccessKey = process.env.TEST_OBJECT_STORAGE_SECRET_KEY;
const dockerContext = process.env.TEST_DOCKER_CONTEXT;
const integration = Boolean(
  sourceUrl &&
  restoreUrl &&
  endpoint &&
  container &&
  accessKeyId &&
  secretAccessKey,
);
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

test(
  "encrypted PostgreSQL and MinIO restore replays current deletion barriers",
  { skip: !integration },
  async () => {
    const source = createPool(sourceUrl!);
    const target = createPool(restoreUrl!);
    const storageConfig = {
      endpoint,
      accessKeyId,
      secretAccessKey,
    };
    const sourceStorage = new S3ObjectStorage({
      ...storageConfig,
      bucket:
        process.env.TEST_SOURCE_BUCKET ?? "crashmemory-v09-recovery-source",
    });
    const targetStorage = new S3ObjectStorage({
      ...storageConfig,
      bucket:
        process.env.TEST_RESTORE_BUCKET ?? "crashmemory-v09-recovery-restore",
    });
    const directory = await mkdtemp(join(tmpdir(), "crashmemory-v09-restore-"));
    const archivePath = join(directory, "archive.enc");
    const journalPath = join(directory, "current-journal.enc");
    const backupKey = Buffer.alloc(32, 17).toString("base64");
    const journalKey = Buffer.alloc(32, 23).toString("base64");
    const user = randomUUID(),
      other = randomUUID(),
      removed = randomUUID();
    const connection = randomUUID(),
      otherConnection = randomUUID();
    const item = randomUUID(),
      blob = randomUUID(),
      revision = randomUUID();
    const deleteItem = randomUUID(),
      deleteBlob = randomUUID(),
      deleteRevision = randomUUID();
    const evidence = randomUUID(),
      obligation = randomUUID(),
      version = randomUUID();
    const supportedObligation = randomUUID(),
      supportedVersion = randomUUID();
    const original = Buffer.from("Synthetic invoice restore marker 71");
    const doomedOriginal = Buffer.from("Synthetic item to delete 73");
    const storageKey = `users/${user}/blobs/${blob}`;
    const doomedKey = `users/${user}/blobs/${deleteBlob}`;
    try {
      await migrate(source);
      await sourceStorage.ensureBucket();
      await targetStorage.ensureBucket();
      await writeFile(journalPath, "", { mode: 0o600 });
      const journal = new EncryptedFileDeletionJournal(journalPath, journalKey);
      for (const id of [user, other, removed])
        await source.query(
          "INSERT INTO users(id,email_normalized,password_hash,time_zone) VALUES ($1,$2,'synthetic','America/Bogota')",
          [id, `${id}@example.test`],
        );
      for (const [id, owner] of [
        [connection, user],
        [otherConnection, other],
      ])
        await source.query(
          "INSERT INTO source_connections(id,user_id,provider,external_account_id,state) VALUES ($1,$2,'gmail',$3,'active')",
          [id, owner, `${owner}@gmail.synthetic`],
        );
      await source.query(
        "INSERT INTO encrypted_credentials(id,user_id,source_connection_id,key_version,iv,ciphertext,auth_tag) VALUES ($1,$2,$3,'v1',$4,$5,$6)",
        [
          randomUUID(),
          other,
          otherConnection,
          Buffer.alloc(12),
          Buffer.from("synthetic"),
          Buffer.alloc(16),
        ],
      );
      await source.query(
        "INSERT INTO telegram_recipients(id,user_id,key_version,iv,ciphertext,auth_tag,state) VALUES ($1,$2,'v1',$3,$4,$5,'active')",
        [
          randomUUID(),
          user,
          Buffer.alloc(12),
          Buffer.from("synthetic"),
          Buffer.alloc(16),
        ],
      );
      await sourceStorage.putIfAbsent(storageKey, original, "message/rfc822");
      await source.query(
        "INSERT INTO blobs(id,user_id,storage_key,content_type,byte_size,content_sha256) VALUES ($1,$2,$3,'message/rfc822',$4,$5)",
        [blob, user, storageKey, original.length, sha(original)],
      );
      await source.query(
        "INSERT INTO source_items(id,user_id,source_connection_id,external_id) VALUES ($1,$2,$3,'invoice-71')",
        [item, user, connection],
      );
      await source.query(
        "INSERT INTO source_item_revisions(id,user_id,source_item_id,revision,original_blob_id,content_sha256,observed_at) VALUES ($1,$2,$3,1,$4,$5,now())",
        [revision, user, item, blob, sha(original)],
      );
      await source.query(
        "INSERT INTO evidence(id,user_id,source_item_revision_id,kind,start_offset,end_offset,quote,content_sha256) VALUES ($1,$2,$3,'email_body_fragment',0,9,'Synthetic',$4)",
        [evidence, user, revision, sha(original)],
      );
      await source.query(
        "INSERT INTO obligations(id,user_id,state) VALUES ($1,$2,'confirmed')",
        [obligation, user],
      );
      await source.query(
        "INSERT INTO obligation_versions(id,user_id,obligation_id,revision,title) VALUES ($1,$2,$3,1,'Synthetic invoice')",
        [version, user, obligation],
      );
      await source.query(
        "UPDATE obligations SET current_version_id=$1 WHERE id=$2",
        [version, obligation],
      );
      await source.query(
        "INSERT INTO obligation_version_evidence(user_id,obligation_version_id,evidence_id) VALUES ($1,$2,$3)",
        [user, version, evidence],
      );
      await source.query(
        "INSERT INTO obligations(id,user_id,state) VALUES ($1,$2,'confirmed')",
        [supportedObligation, user],
      );
      await source.query(
        "INSERT INTO obligation_versions(id,user_id,obligation_id,revision,title) VALUES ($1,$2,$3,1,'Other supported obligation')",
        [supportedVersion, user, supportedObligation],
      );
      await source.query(
        "UPDATE obligations SET current_version_id=$1 WHERE id=$2",
        [supportedVersion, supportedObligation],
      );
      await source.query(
        "INSERT INTO obligation_version_evidence(user_id,obligation_version_id,evidence_id) VALUES ($1,$2,$3)",
        [user, supportedVersion, evidence],
      );
      await sourceStorage.putIfAbsent(
        doomedKey,
        doomedOriginal,
        "message/rfc822",
      );
      await source.query(
        "INSERT INTO blobs(id,user_id,storage_key,content_type,byte_size,content_sha256) VALUES ($1,$2,$3,'message/rfc822',$4,$5)",
        [
          deleteBlob,
          user,
          doomedKey,
          doomedOriginal.length,
          sha(doomedOriginal),
        ],
      );
      await source.query(
        "INSERT INTO source_items(id,user_id,source_connection_id,external_id) VALUES ($1,$2,$3,'delete-me-73')",
        [deleteItem, user, connection],
      );
      await source.query(
        "INSERT INTO source_item_revisions(id,user_id,source_item_id,revision,original_blob_id,content_sha256,observed_at) VALUES ($1,$2,$3,1,$4,$5,now())",
        [deleteRevision, user, deleteItem, deleteBlob, sha(doomedOriginal)],
      );
      const backup = new LifecycleBackupService(source, sourceStorage);
      assert.equal(
        (
          await backup.backup({
            databaseUrl: sourceUrl!,
            outputPath: archivePath,
            encryptionKeyBase64: backupKey,
            journalPath,
            journalKeyBase64: journalKey,
            postgresTools: { container, dockerContext },
          })
        ).objectCount,
        2,
      );
      assert.doesNotMatch(
        await readFile(archivePath, "utf8"),
        /Synthetic invoice restore marker/,
      );
      const lifecycle = new LifecycleService(source, sourceStorage, journal);
      await lifecycle.deleteObligation({
        userId: user,
        obligationId: obligation,
      });
      await lifecycle.deleteSourceItem({
        userId: user,
        connectionId: connection,
        externalMessageId: "delete-me-73",
      });
      await lifecycle.unlinkTelegram({ userId: user });
      await lifecycle.disconnectGmail({
        userId: other,
        connectionId: otherConnection,
      });
      await lifecycle.deleteAccount({ userId: removed });
      // The archive predates this message. Its tombstone must still survive the restore.
      const later = randomUUID();
      await source.query(
        "INSERT INTO source_items(id,user_id,source_connection_id,external_id) VALUES ($1,$2,$3,'later-72')",
        [later, user, connection],
      );
      await lifecycle.deleteSourceItem({
        userId: user,
        connectionId: connection,
        externalMessageId: "later-72",
      });
      const restore = new LifecycleBackupService(target, targetStorage);
      const options = {
        databaseUrl: restoreUrl!,
        archivePath,
        encryptionKeyBase64: backupKey,
        journalPath,
        journalKeyBase64: journalKey,
        postgresTools: { container, dockerContext },
      };
      const tampered = join(directory, "tampered.enc");
      const envelope = JSON.parse(await readFile(archivePath, "utf8")) as {
        ciphertext: string;
      };
      envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
      await writeFile(tampered, JSON.stringify(envelope));
      await assert.rejects(
        restore.restore({ ...options, archivePath: tampered }),
      );
      const partial = join(directory, "partial-journal.enc");
      await writeFile(
        partial,
        (await readFile(journalPath, "utf8")) + "partial",
      );
      await assert.rejects(
        restore.restore({ ...options, journalPath: partial }),
        /partial final line/,
      );
      const invalidJournal = join(directory, "invalid-journal.enc");
      await new EncryptedFileDeletionJournal(invalidJournal, journalKey).append(
        {
          userId: user,
          scope: "unknown_scope",
          tombstoneKey: `${user}:unknown`,
          reason: "invalid",
        },
      );
      await assert.rejects(
        restore.restore({ ...options, journalPath: invalidJournal }),
        /entry is invalid/,
      );
      const wrongJournal = join(directory, "wrong-journal.enc");
      await new EncryptedFileDeletionJournal(
        wrongJournal,
        journalKey,
      ).initialize();
      await assert.rejects(
        restore.restore({ ...options, journalPath: wrongJournal }),
        /does not extend/,
      );
      await assert.rejects(
        backup.backup({
          databaseUrl: sourceUrl!,
          outputPath: join(directory, "invalid-backup.enc"),
          encryptionKeyBase64: backupKey,
          journalPath: wrongJournal,
          journalKeyBase64: journalKey,
          postgresTools: { container, dockerContext },
        }),
        /does not cover/,
      );
      assert.equal(
        (
          await target.query(
            "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'",
          )
        ).rows[0].count,
        0,
      );
      const result = await restore.restore(options);
      assert.equal(result.restoredObjects, 2);
      assert.equal(
        (await target.query("SELECT 1 FROM source_items WHERE id=$1", [item]))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await target.query("SELECT 1 FROM source_items WHERE id=$1", [
            deleteItem,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await target.query("SELECT 1 FROM obligations WHERE id=$1", [
            obligation,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await target.query("SELECT 1 FROM obligations WHERE id=$1", [
            supportedObligation,
          ])
        ).rowCount,
        1,
      );
      assert.deepEqual(
        Buffer.from(await targetStorage.get(storageKey)),
        original,
      );
      assert.equal(
        (await target.query("SELECT 1 FROM users WHERE id=$1", [other]))
          .rowCount,
        1,
      );
      assert.equal(
        (await target.query("SELECT 1 FROM users WHERE id=$1", [removed]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await target.query(
            "SELECT 1 FROM encrypted_credentials WHERE source_connection_id=$1",
            [otherConnection],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await target.query(
            "SELECT state FROM telegram_recipients WHERE user_id=$1",
            [user],
          )
        ).rows[0].state,
        "revoked",
      );
      assert.equal(
        (
          await target.query(
            "SELECT 1 FROM lifecycle_tombstones WHERE user_id=$1 AND external_message_id='later-72'",
            [user],
          )
        ).rowCount,
        1,
      );
      const gmail = new PostgresGmailPersistence(
        target,
        user,
        connection,
        targetStorage,
      );
      await gmail.persistPage({
        reason: "resync",
        messages: [
          {
            externalId: "later-72",
            historyId: "100",
            original: Buffer.from("later"),
            body: "later",
            attachments: [],
          },
        ],
      });
      await gmail.persistPage({
        reason: "resync",
        messages: [
          {
            externalId: "invoice-71",
            historyId: "101",
            original: Buffer.from("replayed"),
            body: "replayed",
            attachments: [],
          },
        ],
      });
      assert.equal(
        (
          await target.query(
            "SELECT 1 FROM source_items WHERE user_id=$1 AND external_id='later-72'",
            [user],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await target.query(
            "SELECT count(*)::int AS count FROM source_item_revisions WHERE source_item_id=$1",
            [item],
          )
        ).rows[0].count,
        1,
      );
      const candidate = randomUUID();
      await target.query(
        "INSERT INTO extraction_candidates(id,user_id,source_item_revision_id,title,amount,currency,due,state) VALUES ($1,$2,$3,'Replayed deleted knowledge',1,'COP',$4,'ready')",
        [
          candidate,
          user,
          revision,
          {
            kind: "civil_date",
            date: "2099-01-01",
            timeZone: "America/Bogota",
          },
        ],
      );
      await target.query(
        "INSERT INTO extraction_candidate_evidence(candidate_id,evidence_id,user_id,source_item_revision_id) VALUES ($1,$2,$3,$4)",
        [candidate, evidence, user, revision],
      );
      const client = await target.connect();
      try {
        await client.query("BEGIN");
        await new ReconciliationService(target).consumeCandidate(
          {
            userId: user,
            payload: {
              obligationId: candidate,
              sourceItemRevisionId: revision,
            },
          } as never,
          client,
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.equal(
        (
          await target.query(
            "SELECT 1 FROM reconciliation_candidate_links WHERE candidate_id=$1",
            [candidate],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await target.query("SELECT count(*)::int AS count FROM blobs")).rows[0]
          .count,
        1,
      );
    } finally {
      await source.end();
      await target.end();
    }
  },
);
