import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createPool,
  migrate,
  SourceRepository,
  ExtractionRepository,
  DurableRuntimeRepository,
  SessionRepository,
  NotificationRepository,
} from "@crashmemory/db";
import { ConsumerRegistry, MemoryObjectStorage } from "@crashmemory/runtime";
import {
  registerNotificationConsumers,
  ReminderScheduler,
} from "@crashmemory/notifications";
import {
  ReconciliationService,
  registerReconciliationConsumer,
} from "@crashmemory/reconciliation";

const databaseUrl = process.env.TEST_DATABASE_URL;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test(
  "V05 candidates reconcile atomically through V03 receipt, preserve revisions and drive V07",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    const storage = new MemoryObjectStorage();
    const userId = randomUUID();
    const connectionId = randomUUID();
    const sessionId = randomUUID();
    const source = new SourceRepository(pool);
    const extraction = new ExtractionRepository(pool);
    const service = new ReconciliationService(pool);
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO users(id,email_normalized,password_hash,time_zone) VALUES ($1,$2,'synthetic','America/Bogota')",
        [userId, `${userId}@example.test`],
      );
      await new SessionRepository(pool).create({
        id: sessionId,
        userId,
        tokenHash: hash(randomUUID()),
        csrfTokenHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await source.createConnection({
        id: connectionId,
        userId,
        externalAccountId: `${userId}@gmail.synthetic`,
        state: "active",
      });
      const registry = new ConsumerRegistry(new DurableRuntimeRepository(pool));
      registerReconciliationConsumer(registry, service);
      registerNotificationConsumers(
        registry,
        new ReminderScheduler(
          pool,
          [{ id: "synthetic", offsetMinutes: -60 }],
          true,
        ),
      );

      async function candidate(input: {
        reference: string;
        date: string;
        observedAt: string;
        externalId?: string;
        amount?: string;
        accountOnly?: boolean;
      }) {
        const text = input.accountOnly
          ? `Acme Agua Cuenta ACCT-77 COP ${input.amount ?? "48.50"} vence ${input.date}`
          : `Acme Agua Cuenta ACCT-77 Factura ${input.reference} COP ${input.amount ?? "48.50"} vence ${input.date}`;
        const bytes = Buffer.from(text);
        const blobId = randomUUID();
        const key = `users/${userId}/blobs/${blobId}`;
        await storage.putIfAbsent(key, bytes);
        await source.createBlob({
          id: blobId,
          userId,
          storageKey: key,
          contentType: "text/plain",
          byteSize: bytes.length,
          contentSha256: hash(text),
        });
        const itemId = randomUUID();
        const revisionId = randomUUID();
        await source.createItem({
          id: itemId,
          userId,
          sourceConnectionId: connectionId,
          externalId: input.externalId ?? itemId,
        });
        await source.createRevision({
          id: revisionId,
          userId,
          sourceItemId: itemId,
          revision: 1,
          originalBlobId: blobId,
          contentSha256: hash(text),
          observedAt: new Date(input.observedAt),
        });
        await source.createNormalizedBody({
          id: randomUUID(),
          userId,
          sourceItemRevisionId: revisionId,
          bodyBlobId: blobId,
          contentSha256: hash(text),
          utf16Length: text.length,
          normalizationVersion: "v1",
        });
        const jobId = randomUUID();
        await pool.query(
          `INSERT INTO extraction_jobs(id,user_id,source_item_revision_id,privacy_profile,state)
         VALUES ($1,$2,$3,'local-only','running')`,
          [jobId, userId, revisionId],
        );
        const candidateId = randomUUID();
        await extraction.complete({
          jobId,
          userId,
          candidates: [
            {
              id: candidateId,
              title: "Factura de agua",
              amount: { amount: input.amount ?? "48.50", currency: "COP" },
              due: {
                kind: "civil_date",
                date: input.date,
                timeZone: "America/Bogota",
              },
              identity: { issuer: "Acme Agua", reference: input.reference },
              evidence: [
                {
                  id: randomUUID(),
                  kind: "email_body_fragment",
                  sourceItemRevisionId: revisionId,
                  startOffset: 0,
                  endOffset: text.length,
                  quote: text,
                  contentSha256: hash(text),
                },
              ],
            },
          ],
        });
        const event = await pool.query<{ id: string }>(
          "SELECT id FROM outbox_events WHERE event_type='obligation.candidate.created.v1' AND aggregate_id=$1",
          [candidateId],
        );
        return {
          id: candidateId,
          eventId: event.rows[0]!.id,
          text,
          revisionId,
        };
      }
      const first = await candidate({
        reference: "INV-1001",
        date: "2026-10-15",
        observedAt: "2026-09-20T10:00:00Z",
      });
      await Promise.all([
        registry.consume({ id: first.eventId }),
        registry.consume({ id: first.eventId }),
      ]);
      const linked = await pool.query<{ obligation_id: string }>(
        "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=$1",
        [first.id],
      );
      const obligationId = linked.rows[0]!.obligation_id;
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM obligation_versions WHERE obligation_id=$1",
            [obligationId],
          )
        ).rowCount,
        1,
      );
      await service.mutate({
        userId,
        sessionId,
        obligationId,
        expectedVersion: 1,
        action: "confirm",
      });
      const confirmEvent = await pool.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE event_type='obligation.version.created.v1'
       AND aggregate_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [obligationId],
      );
      await registry.consume({ id: confirmEvent.rows[0]!.id });
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM reminders WHERE obligation_id=$1 AND state='scheduled'",
            [obligationId],
          )
        ).rowCount,
        1,
      );

      const changed = await candidate({
        reference: "INV-1001",
        date: "2026-10-22",
        observedAt: "2026-09-21T10:00:00Z",
      });
      await registry.consume({ id: changed.eventId });
      const conflict = await pool.query<{ state: string; reason: string }>(
        "SELECT state,reason FROM obligation_conflicts WHERE candidate_id=$1",
        [changed.id],
      );
      assert.equal(conflict.rows[0]?.reason, "protected_field");
      assert.equal(
        (
          await pool.query("SELECT state FROM obligations WHERE id=$1", [
            obligationId,
          ])
        ).rows[0]?.state,
        "conflict",
      );
      const staleReminder = (
        await pool.query<{ id: string; target_version: number }>(
          "SELECT id,target_version FROM reminders WHERE obligation_id=$1",
          [obligationId],
        )
      ).rows[0]!;
      await pool.query("UPDATE reminders SET state='delivering' WHERE id=$1", [
        staleReminder.id,
      ]);
      assert.equal(
        await new NotificationRepository(pool).isDeliveryCurrent({
          reminderId: staleReminder.id,
          userId,
          targetVersion: staleReminder.target_version,
        }),
        false,
      );
      const reschedule = await pool.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE event_type='obligation.reminder.reschedule.requested.v1'
       AND aggregate_id=$1 ORDER BY occurred_at DESC LIMIT 1`,
        [obligationId],
      );
      await registry.consume({ id: reschedule.rows[0]!.id });
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM reminders WHERE obligation_id=$1 AND state='scheduled'",
            [obligationId],
          )
        ).rowCount,
        0,
      );
      const conflictId = (
        await pool.query<{ id: string }>(
          "SELECT id FROM obligation_conflicts WHERE candidate_id=$1",
          [changed.id],
        )
      ).rows[0]!.id;
      await assert.rejects(
        service.mutate({
          userId,
          sessionId,
          obligationId,
          expectedVersion: 1,
          action: "resolve",
          conflictId,
          resolution: "accept",
        }),
        (error: { code?: string }) => error.code === "stale_version",
      );
      await service.mutate({
        userId,
        sessionId,
        obligationId,
        expectedVersion: 3,
        action: "resolve",
        conflictId,
        resolution: "accept",
      });
      const resolved = await pool.query<{ revision: number; due_date: string }>(
        `SELECT v.revision,v.due_date::text FROM obligations o
       JOIN obligation_versions v ON v.id=o.current_version_id WHERE o.id=$1`,
        [obligationId],
      );
      assert.equal(resolved.rows[0]?.revision, 4);
      assert.equal(resolved.rows[0]?.due_date, "2026-10-22");
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM obligation_versions WHERE obligation_id=$1",
            [obligationId],
          )
        ).rowCount,
        4,
      );
      await assert.rejects(
        pool.query(
          "UPDATE obligation_versions SET title='tampered' WHERE obligation_id=$1",
          [obligationId],
        ),
        (error: { code?: string }) => error.code === "55000",
      );

      const older = await candidate({
        reference: "INV-1001",
        date: "2026-10-01",
        observedAt: "2026-09-19T10:00:00Z",
      });
      await registry.consume({ id: older.eventId });
      assert.equal(
        (
          await pool.query(
            "SELECT reason FROM obligation_conflicts WHERE candidate_id=$1",
            [older.id],
          )
        ).rows[0]?.reason,
        "out_of_order",
      );
      assert.equal(
        (
          await pool.query("SELECT state FROM obligations WHERE id=$1", [
            obligationId,
          ])
        ).rows[0]?.state,
        "confirmed",
      );

      const secondMonthly = await candidate({
        reference: "INV-1002",
        date: "2026-11-15",
        observedAt: "2026-10-20T10:00:00Z",
      });
      const sameAccountOnly = await candidate({
        reference: "ACCT-77",
        date: "2026-12-15",
        observedAt: "2026-11-20T10:00:00Z",
        accountOnly: true,
      });
      await Promise.all([
        registry.consume({ id: secondMonthly.eventId }),
        registry.consume({ id: sameAccountOnly.eventId }),
      ]);
      const ids = await pool.query<{ obligation_id: string }>(
        "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=ANY($1::uuid[]) ORDER BY obligation_id",
        [[first.id, secondMonthly.id, sameAccountOnly.id]],
      );
      assert.equal(new Set(ids.rows.map((item) => item.obligation_id)).size, 3);
      const monthlyId = (
        await pool.query<{ obligation_id: string }>(
          "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=$1",
          [secondMonthly.id],
        )
      ).rows[0]!.obligation_id;
      await service.mutate({
        userId,
        sessionId,
        obligationId: monthlyId,
        expectedVersion: 1,
        action: "correct",
        changes: { amount: { amount: "50.00", currency: "COP" } },
      });
      const monthlyChanged = await candidate({
        reference: "INV-1002",
        date: "2026-11-15",
        amount: "60.00",
        observedAt: "2026-10-21T10:00:00Z",
      });
      await registry.consume({ id: monthlyChanged.eventId });
      assert.equal(
        (
          await pool.query("SELECT state FROM obligations WHERE id=$1", [
            monthlyId,
          ])
        ).rows[0]?.state,
        "conflict",
      );
      const monthlyConflictId = (
        await pool.query<{ id: string }>(
          "SELECT id FROM obligation_conflicts WHERE candidate_id=$1",
          [monthlyChanged.id],
        )
      ).rows[0]!.id;
      await service.mutate({
        userId,
        sessionId,
        obligationId: monthlyId,
        expectedVersion: 3,
        action: "resolve",
        conflictId: monthlyConflictId,
        resolution: "reject",
      });
      assert.equal(
        (
          await pool.query("SELECT state FROM obligations WHERE id=$1", [
            monthlyId,
          ])
        ).rows[0]?.state,
        "candidate",
      );
      const monthlyEvent = (
        await pool.query<{ id: string }>(
          `SELECT id FROM outbox_events WHERE event_type='obligation.version.created.v1' AND aggregate_id=$1
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
          [monthlyId],
        )
      ).rows[0]!.id;
      await registry.consume({ id: monthlyEvent });
      assert.equal(
        (
          await pool.query("SELECT 1 FROM reminders WHERE obligation_id=$1", [
            monthlyId,
          ])
        ).rowCount,
        0,
      );
      await service.mutate({
        userId,
        sessionId,
        obligationId: monthlyId,
        expectedVersion: 4,
        action: "discard",
      });
      const discardedReplay = await candidate({
        reference: "INV-1002",
        date: "2026-11-22",
        amount: "60.00",
        observedAt: "2026-10-22T10:00:00Z",
      });
      await registry.consume({ id: discardedReplay.eventId });
      assert.equal(
        (
          await pool.query("SELECT state FROM obligations WHERE id=$1", [
            monthlyId,
          ])
        ).rows[0]?.state,
        "discarded",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT reason FROM obligation_conflicts WHERE candidate_id=$1",
            [discardedReplay.id],
          )
        ).rows[0]?.reason,
        "terminal_state",
      );
      const third = await candidate({
        reference: "INV-1003",
        date: "2026-12-15",
        amount: "48.50",
        observedAt: "2026-11-20T10:00:00Z",
      });
      await registry.consume({ id: third.eventId });
      const thirdUpdated = await candidate({
        reference: "INV-1003",
        date: "2026-12-20",
        amount: "48.5",
        observedAt: "2026-11-21T10:00:00Z",
      });
      await registry.consume({ id: thirdUpdated.eventId });
      const thirdLinks = await pool.query<{ obligation_id: string }>(
        "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=ANY($1::uuid[])",
        [[third.id, thirdUpdated.id]],
      );
      assert.equal(
        new Set(thirdLinks.rows.map((item) => item.obligation_id)).size,
        1,
      );
      const thirdId = thirdLinks.rows[0]!.obligation_id;
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM obligation_versions WHERE obligation_id=$1",
            [thirdId],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT v.due_date::text AS due_date FROM obligations o
       JOIN obligation_versions v ON v.id=o.current_version_id WHERE o.id=$1`,
            [thirdId],
          )
        ).rows[0]?.due_date,
        "2026-12-20",
      );
      const thirdEquivalent = await candidate({
        reference: "INV-1003",
        date: "2026-12-20",
        amount: "48.500",
        observedAt: "2026-11-22T10:00:00Z",
      });
      await registry.consume({ id: thirdEquivalent.eventId });
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM obligation_versions WHERE obligation_id=$1",
            [thirdId],
          )
        ).rowCount,
        2,
      );
      const fourth = await candidate({
        reference: "INV-1004",
        date: "2027-01-15",
        observedAt: "2026-12-20T10:00:00Z",
      });
      const fourthNewer = await candidate({
        reference: "INV-1004",
        date: "2027-01-20",
        observedAt: "2026-12-21T10:00:00Z",
      });
      await Promise.all([
        registry.consume({ id: fourth.eventId }),
        registry.consume({ id: fourthNewer.eventId }),
      ]);
      const fourthLinks = await pool.query<{ obligation_id: string }>(
        "SELECT obligation_id FROM reconciliation_candidate_links WHERE candidate_id=ANY($1::uuid[])",
        [[fourth.id, fourthNewer.id]],
      );
      assert.equal(
        new Set(fourthLinks.rows.map((item) => item.obligation_id)).size,
        1,
      );
      await service.mutate({
        userId,
        sessionId,
        obligationId,
        expectedVersion: 4,
        action: "pay",
      });
      await registry.consume({ id: first.eventId });
      const afterPay = await pool.query<{ state: string; revision: number }>(
        `SELECT o.state,v.revision FROM obligations o JOIN obligation_versions v ON v.id=o.current_version_id
       WHERE o.id=$1`,
        [obligationId],
      );
      assert.equal(afterPay.rows[0]?.state, "paid");
      assert.equal(afterPay.rows[0]?.revision, 5);
    } finally {
      await pool.end();
    }
  },
);
