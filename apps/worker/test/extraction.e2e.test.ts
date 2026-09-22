import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  DurableRuntimeRepository,
  ExtractionRepository,
  SourceRepository,
  createPool,
  migrate,
} from "@crashmemory/db";
import {
  DurableExtractionRunner,
  ExtractionService,
  PostgresExtractionDocumentLoader,
} from "@crashmemory/extraction";
import { PostgresGmailPersistence } from "@crashmemory/gmail/postgres";
import {
  FakeStructuredModel,
  ModelGateway,
  loadRemoteModelConfig,
} from "@crashmemory/model-gateway";
import { ConsumerRegistry, MemoryObjectStorage } from "@crashmemory/runtime";
import { registerExtractionConsumer } from "../src/extraction-consumer.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

function syntheticPdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const text of pageTexts) {
    const content = `BT /F1 14 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function gateway(value: unknown): ModelGateway {
  return new ModelGateway({
    local: new FakeStructuredModel({ value }),
    remoteConfig: loadRemoteModelConfig({}),
  });
}

test(
  "worker consumer, durable runner and authorized loader persist pages, evidence and recover safely",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const connectionId = randomUUID();
    const storage = new MemoryObjectStorage();
    try {
      await migrate(pool);
      const sources = new SourceRepository(pool);
      for (const [id, zone] of [
        [userId, "America/Bogota"],
        [otherUserId, "Europe/Madrid"],
      ]) {
        await pool.query(
          "INSERT INTO users(id, email_normalized, password_hash, time_zone) VALUES ($1,$2,'synthetic',$3)",
          [id, `${id}@example.test`, zone],
        );
      }
      await sources.createConnection({
        id: connectionId,
        userId,
        externalAccountId: `${userId}@gmail.synthetic`,
        state: "active",
      });
      const gmail = new PostgresGmailPersistence(
        pool,
        userId,
        connectionId,
        storage,
      );
      const body =
        "Factura de agua COP $ 48.250,50 vence el 15 de octubre de 2026.";
      await gmail.persistPage({
        reason: "incremental",
        messages: [
          {
            externalId: "candidate-with-pdf",
            historyId: "1",
            original: new TextEncoder().encode(
              "From: synthetic@example.test\n\n" + body,
            ),
            body,
            attachments: [
              {
                externalAttachmentId: "invoice-pdf",
                fileName: "invoice.pdf",
                mediaType: "application/pdf",
                bytes: syntheticPdf(["Invoice page one", "Invoice page two"]),
              },
            ],
          },
        ],
      });
      const revision = await pool.query<{ id: string }>(
        "SELECT id FROM source_item_revisions WHERE user_id = $1 ORDER BY observed_at DESC LIMIT 1",
        [userId],
      );
      const revisionId = revision.rows[0]!.id;
      const event = await pool.query<{ id: string }>(
        "SELECT id FROM outbox_events WHERE user_id = $1 AND event_type = 'source.item.revision.created.v1' ORDER BY occurred_at DESC LIMIT 1",
        [userId],
      );
      const registry = new ConsumerRegistry(new DurableRuntimeRepository(pool));
      registerExtractionConsumer(registry);
      await registry.consume({ id: event.rows[0]!.id });
      await registry.consume({ id: event.rows[0]!.id });

      const extraction = new ExtractionRepository(pool);
      const loader = new PostgresExtractionDocumentLoader(
        pool,
        extraction,
        storage,
      );
      assert.equal(await loader.load(otherUserId, revisionId), null);
      const amountStart = body.indexOf("COP");
      const runner = new DurableExtractionRunner(
        new ExtractionService(
          gateway({
            candidates: [
              {
                title: "Factura de agua",
                amount: { amount: "48250.50", currency: "COP" },
                due: {
                  kind: "civil_date",
                  date: "2026-10-15",
                  timeZone: "America/Bogota",
                },
                evidence: [
                  {
                    source: "body",
                    attachmentId: null,
                    page: null,
                    startOffset: amountStart,
                    endOffset: body.length,
                  },
                ],
                ambiguous: false,
              },
            ],
          }),
        ),
        extraction,
        loader,
      );
      assert.equal(await runner.runOne(), "completed");
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM extraction_pdf_pages WHERE user_id = $1",
            [userId],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM extraction_candidates WHERE user_id = $1",
            [userId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM extraction_candidate_evidence WHERE user_id = $1",
            [userId],
          )
        ).rowCount,
        1,
      );
      const candidate = await pool.query<{
        id: string;
        source_item_revision_id: string;
      }>(
        "SELECT id, source_item_revision_id FROM extraction_candidates WHERE user_id = $1",
        [userId],
      );
      const evidence = await pool.query<{ id: string }>(
        "SELECT id FROM evidence WHERE user_id = $1",
        [userId],
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO extraction_candidate_evidence(candidate_id,evidence_id,user_id,source_item_revision_id) VALUES ($1,$2,$3,$4)",
          [
            randomUUID(),
            evidence.rows[0]!.id,
            otherUserId,
            candidate.rows[0]!.source_item_revision_id,
          ],
        ),
        (error: { code?: string }) => error.code === "23503",
      );

      await gmail.persistPage({
        reason: "incremental",
        messages: [
          {
            externalId: "ordinary-mail",
            historyId: "2",
            original: new TextEncoder().encode("hello"),
            body: "Hola, la reunión es mañana.",
            attachments: [],
          },
        ],
      });
      const ordinaryEvent = await pool.query<{ id: string }>(
        "SELECT id FROM outbox_events WHERE user_id = $1 AND event_type = 'source.item.revision.created.v1' ORDER BY occurred_at DESC LIMIT 1",
        [userId],
      );
      await registry.consume({ id: ordinaryEvent.rows[0]!.id });
      const emptyRunner = new DurableExtractionRunner(
        new ExtractionService(gateway({ candidates: [] })),
        extraction,
        loader,
      );
      assert.equal(await emptyRunner.runOne(), "completed");
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM extraction_candidates WHERE user_id = $1",
            [userId],
          )
        ).rowCount,
        1,
      );

      await gmail.persistPage({
        reason: "incremental",
        messages: [
          {
            externalId: "scanned-mail",
            historyId: "3",
            original: new TextEncoder().encode("scanned"),
            body: "Adjunto documento.",
            attachments: [
              {
                externalAttachmentId: "scan",
                fileName: "scan.pdf",
                mediaType: "application/pdf",
                bytes: new TextEncoder().encode("not a pdf"),
              },
            ],
          },
        ],
      });
      const scannedEvent = await pool.query<{ id: string }>(
        "SELECT id FROM outbox_events WHERE user_id = $1 AND event_type = 'source.item.revision.created.v1' ORDER BY occurred_at DESC LIMIT 1",
        [userId],
      );
      await registry.consume({ id: scannedEvent.rows[0]!.id });
      assert.equal(await emptyRunner.runOne(), "manual_review");
      assert.equal(
        (
          await pool.query<{ last_error_code: string }>(
            "SELECT last_error_code FROM extraction_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
            [userId],
          )
        ).rows[0]?.last_error_code,
        "pdf_requires_manual_review",
      );

      await gmail.persistPage({
        reason: "incremental",
        messages: [
          {
            externalId: "lease-replay-mail",
            historyId: "4",
            original: new TextEncoder().encode("lease replay"),
            body: "Correo sintético para recuperación.",
            attachments: [],
          },
        ],
      });
      const leaseEvent = await pool.query<{ id: string }>(
        "SELECT id FROM outbox_events WHERE user_id = $1 AND event_type = 'source.item.revision.created.v1' ORDER BY occurred_at DESC LIMIT 1",
        [userId],
      );
      await registry.consume({ id: leaseEvent.rows[0]!.id });
      const claimed = await extraction.claimNext();
      assert.ok(claimed);
      const leaseJob = { id: claimed.id };
      await pool.query(
        "UPDATE extraction_jobs SET state = 'running', claimed_at = now() - interval '2 minutes', completed_at = NULL WHERE id = $1",
        [leaseJob.id],
      );
      assert.equal(await extraction.recoverExpired(new Date(), 60_000), 1);
      assert.equal(
        (
          await pool.query<{ state: string; last_error_code: string }>(
            "SELECT state, last_error_code FROM extraction_jobs WHERE id = $1",
            [leaseJob.id],
          )
        ).rows[0]?.last_error_code,
        "lease_expired",
      );
      assert.equal(await extraction.claimNext(), null);
    } finally {
      await pool.end();
    }
  },
);
