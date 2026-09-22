import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SourceRepository, createPool, migrate } from "@crashmemory/db";
import { MemoryObjectStorage } from "@crashmemory/runtime";
import { PostgresGmailPersistence } from "../src/postgres.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres Gmail persistence atomically exposes V05 input and one outbox event",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    const userId = randomUUID();
    const connectionId = randomUUID();
    try {
      await migrate(pool);
      await pool.query(
        `INSERT INTO users(id, email_normalized, password_hash, time_zone)
       VALUES ($1, $2, 'synthetic', 'America/Bogota')`,
        [userId, `${userId}@example.test`],
      );
      await new SourceRepository(pool).createConnection({
        id: connectionId,
        userId,
        externalAccountId: "gmail.synthetic@example.test",
        state: "active",
      });
      const persistence = new PostgresGmailPersistence(
        pool,
        userId,
        connectionId,
        new MemoryObjectStorage(),
      );
      const message = {
        externalId: "gmail-message-1",
        historyId: "44",
        original: new TextEncoder().encode(
          "From: synthetic@example.test\r\n\r\nFactura",
        ),
        body: "Factura 😀",
        attachments: [
          {
            externalAttachmentId: "pdf-1",
            fileName: "invoice.pdf",
            mediaType: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]),
          },
        ],
      };
      await persistence.persistPage({
        messages: [message],
        reason: "incremental",
      });
      await persistence.persistPage({
        messages: [message],
        reason: "incremental",
      });
      const revision = await pool.query<{ id: string }>(
        "SELECT id FROM source_item_revisions WHERE user_id = $1",
        [userId],
      );
      assert.equal(revision.rowCount, 1);
      const extraction = await new SourceRepository(pool).getExtractionInput(
        userId,
        revision.rows[0]!.id,
      );
      assert.equal(extraction?.body.utf16Length, message.body.length);
      assert.equal(extraction?.body.normalizationVersion, "gmail-body-v2");
      assert.equal(extraction?.attachments[0]?.mediaType, "application/pdf");
      const events = await pool.query(
        "SELECT * FROM outbox_events WHERE user_id = $1",
        [userId],
      );
      assert.equal(events.rowCount, 1);
      await persistence.confirmCursor("44");
      const cursor = await pool.query<{ cursor_value: string }>(
        "SELECT cursor_value FROM sync_cursors WHERE source_connection_id = $1",
        [connectionId],
      );
      assert.equal(cursor.rows[0]?.cursor_value, "44");
    } finally {
      await pool.end();
    }
  },
);
