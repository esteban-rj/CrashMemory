import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DurableRuntimeRepository,
  ExtractionRepository,
  NotificationRepository,
  SessionRepository,
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
import {
  NotificationDispatcher,
  ReminderScheduler,
  TelegramLinkService,
  registerNotificationConsumers,
} from "@crashmemory/notifications";
import {
  ReconciliationService,
  registerReconciliationConsumer,
} from "@crashmemory/reconciliation";
import { ConsumerRegistry, S3ObjectStorage } from "@crashmemory/runtime";
import { CredentialCipher, hashOpaqueToken } from "@crashmemory/security";
import { registerExtractionConsumer } from "./extraction-consumer.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
function syntheticPdf(text: string): Uint8Array {
  const content = `BT /F1 14 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function main(): Promise<void> {
  const pool = createPool(required("DATABASE_URL"));
  const storage = new S3ObjectStorage({
    endpoint: required("OBJECT_STORAGE_ENDPOINT"),
    bucket: required("OBJECT_STORAGE_BUCKET"),
    accessKeyId: required("OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: required("OBJECT_STORAGE_SECRET_KEY"),
  });
  try {
    await migrate(pool);
    const email = required("SEED_EMAIL").normalize("NFKC").trim().toLowerCase();
    const user = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email_normalized=$1",
      [email],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("Run db:seed before acceptance:seed");
    const session = await pool.query<{ id: string }>(
      "SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    let sessionId = session.rows[0]?.id;
    if (!sessionId) {
      sessionId = randomUUID();
      await new SessionRepository(pool).create({
        id: sessionId,
        userId,
        tokenHash: hashOpaqueToken(randomUUID()),
        csrfTokenHash: hashOpaqueToken(randomUUID()),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    const source = new SourceRepository(pool);
    const connectionId = randomUUID();
    await source.createConnection({
      id: connectionId,
      userId,
      externalAccountId: `acceptance-${connectionId}@gmail.synthetic`,
      state: "active",
    });
    const reference = `ACCEPT-${connectionId.slice(0, 8).toUpperCase()}`;
    const gmail = new PostgresGmailPersistence(
      pool,
      userId,
      connectionId,
      storage,
    );
    const extraction = new ExtractionRepository(pool);
    const loader = new PostgresExtractionDocumentLoader(
      pool,
      extraction,
      storage,
    );
    const runtime = new DurableRuntimeRepository(pool);
    const registry = new ConsumerRegistry(runtime);
    registerExtractionConsumer(registry, "local-only");
    const reconciliation = new ReconciliationService(pool);
    registerReconciliationConsumer(registry, reconciliation);
    registerNotificationConsumers(
      registry,
      new ReminderScheduler(pool, undefined, true),
    );
    let remoteCalls = 0;

    async function ingest(input: {
      externalId: string;
      due: string;
      amount: string;
    }): Promise<string> {
      const body = `Acueducto Ejemplo Factura ${reference} COP ${input.amount} vence ${input.due}.`;
      await gmail.persistPage({
        reason: "incremental",
        messages: [
          {
            externalId: input.externalId,
            historyId: String(Date.now()),
            original: new TextEncoder().encode(
              `From: facturas@example.test\r\n\r\n${body}`,
            ),
            body,
            attachments: [
              {
                externalAttachmentId: `${input.externalId}-pdf`,
                fileName: "factura.pdf",
                mediaType: "application/pdf",
                bytes: syntheticPdf(`Factura ${reference} vence ${input.due}`),
              },
            ],
          },
        ],
      });
      const revision = await pool.query<{ id: string }>(
        `SELECT r.id FROM source_item_revisions r JOIN source_items i ON i.id=r.source_item_id
         WHERE i.user_id=$1 AND i.external_id=$2 ORDER BY r.revision DESC LIMIT 1`,
        [userId, input.externalId],
      );
      const sourceEvent = await pool.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE user_id=$1 AND event_type='source.item.revision.created.v1'
         ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [userId],
      );
      await registry.consume({ id: sourceEvent.rows[0]!.id });
      const runner = new DurableExtractionRunner(
        new ExtractionService(
          new ModelGateway({
            remoteConfig: loadRemoteModelConfig({}),
            local: new FakeStructuredModel({
              value: {
                candidates: [
                  {
                    title: "Factura de acueducto",
                    amount: { amount: input.amount, currency: "COP" },
                    due: {
                      kind: "civil_date",
                      date: input.due,
                      timeZone: "America/Bogota",
                    },
                    identity: {
                      issuer: "Acueducto Ejemplo",
                      reference,
                    },
                    evidence: [
                      {
                        source: "body",
                        attachmentId: null,
                        page: null,
                        startOffset: 0,
                        endOffset: body.length,
                      },
                    ],
                    ambiguous: false,
                  },
                ],
              },
            }),
            remote: {
              run: async () => {
                remoteCalls += 1;
                return { value: { candidates: [] } };
              },
            },
          }),
        ),
        extraction,
        loader,
      );
      assert.equal(await runner.runOne(), "completed");
      const candidate = await pool.query<{ id: string }>(
        "SELECT id FROM extraction_candidates WHERE source_item_revision_id=$1",
        [revision.rows[0]!.id],
      );
      const candidateEvent = await pool.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE event_type='obligation.candidate.created.v1'
         AND aggregate_id=$1 ORDER BY occurred_at DESC LIMIT 1`,
        [candidate.rows[0]!.id],
      );
      await registry.consume({ id: candidateEvent.rows[0]!.id });
      return candidate.rows[0]!.id;
    }

    const first = await ingest({
      externalId: `acceptance-original-${connectionId}`,
      due: "2027-10-15",
      amount: "48250.50",
    });
    const linked = await pool.query<{ obligation_id: string }>(
      "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=$1",
      [first],
    );
    const obligationId = linked.rows[0]!.obligation_id;
    await reconciliation.mutate({
      userId,
      sessionId,
      obligationId,
      expectedVersion: 1,
      action: "confirm",
    });
    const confirmEvent = await pool.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type='obligation.version.created.v1' AND aggregate_id=$1
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [obligationId],
    );
    await registry.consume({ id: confirmEvent.rows[0]!.id });

    const changed = await ingest({
      externalId: `acceptance-change-${connectionId}`,
      due: "2027-10-22",
      amount: "48250.50",
    });
    const conflict = await pool.query<{ id: string }>(
      "SELECT id FROM obligation_conflicts WHERE candidate_id=$1 AND state='open'",
      [changed],
    );
    await reconciliation.mutate({
      userId,
      sessionId,
      obligationId,
      expectedVersion: 3,
      action: "resolve",
      conflictId: conflict.rows[0]!.id,
      resolution: "accept",
    });
    const current = await pool.query<{ id: string; revision: number }>(
      `SELECT v.id,v.revision FROM obligations o JOIN obligation_versions v ON v.id=o.current_version_id
       WHERE o.id=$1`,
      [obligationId],
    );
    const versionEvent = await pool.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type='obligation.version.created.v1' AND aggregate_id=$1
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [obligationId],
    );
    await registry.consume({ id: versionEvent.rows[0]!.id });

    const cipher = CredentialCipher.fromEnvironment(
      required("CREDENTIAL_ENCRYPTION_KEYS_JSON"),
      required("CREDENTIAL_ACTIVE_KEY_VERSION"),
    );
    const links = new TelegramLinkService(pool, cipher);
    const challenge = await links.start(userId);
    await links.acceptStart({ token: challenge.token, chatId: "424242" });
    let sends = 0;
    const dispatcher = new NotificationDispatcher(pool, cipher, {
      async send() {
        sends += 1;
        return { outcome: "sent", providerMessageId: `fake-${sends}` };
      },
    });
    const reminders = await pool.query<{ id: string; target_version: number }>(
      `SELECT id,target_version FROM reminders WHERE obligation_id=$1 AND obligation_version_id=$2
       AND state='scheduled' ORDER BY scheduled_for,id`,
      [obligationId, current.rows[0]!.id],
    );
    const sent = reminders.rows[0]!;
    await dispatcher.deliver({
      id: randomUUID(),
      userId,
      type: "reminder.delivery.requested.v1",
      aggregateType: "reminder",
      aggregateId: sent.id,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: { reminderId: sent.id, targetVersion: sent.target_version },
    });
    await dispatcher.deliver({
      id: randomUUID(),
      userId,
      type: "reminder.delivery.requested.v1",
      aggregateType: "reminder",
      aggregateId: sent.id,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: { reminderId: sent.id, targetVersion: sent.target_version },
    });
    assert.equal(sends, 1);
    const interrupted = reminders.rows[1]!;
    await new NotificationRepository(pool).prepareDelivery({
      id: randomUUID(),
      reminderId: interrupted.id,
      userId,
      targetVersion: interrupted.target_version,
    });
    await dispatcher.deliver({
      id: randomUUID(),
      userId,
      type: "reminder.delivery.requested.v1",
      aggregateType: "reminder",
      aggregateId: interrupted.id,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: {
        reminderId: interrupted.id,
        targetVersion: interrupted.target_version,
      },
    });
    assert.equal(sends, 1);
    assert.equal(remoteCalls, 0);
    await reconciliation.mutate({
      userId,
      sessionId,
      obligationId,
      expectedVersion: current.rows[0]!.revision,
      action: "pay",
    });
    const reschedule = await pool.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type='obligation.reminder.reschedule.requested.v1'
       AND aggregate_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [obligationId],
    );
    await registry.consume({ id: reschedule.rows[0]!.id });
    const states = await pool.query<{ state: string }>(
      "SELECT state FROM reminders WHERE obligation_id=$1",
      [obligationId],
    );
    assert.ok(states.rows.every((row) => row.state !== "scheduled"));
    const outcomes = await pool.query<{ outcome: string }>(
      `SELECT r.outcome FROM notification_delivery_attempts a
       JOIN notification_delivery_resolutions r ON r.attempt_id=a.id
       WHERE a.reminder_id=ANY($1::uuid[]) ORDER BY r.outcome`,
      [[sent.id, interrupted.id]],
    );
    assert.deepEqual(
      outcomes.rows.map((row) => row.outcome),
      ["sent", "unknown"],
    );
    console.log(
      JSON.stringify({
        event: "mvp_acceptance_fixture_ready",
        email,
        userId,
        connectionId,
        obligationId,
        sentReminderId: sent.id,
        unknownReminderId: interrupted.id,
        remoteCalls,
      }),
    );
  } finally {
    await pool.end();
  }
}

await main();
