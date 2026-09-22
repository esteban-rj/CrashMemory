import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  OAuthCallbackRepository,
  ModelBudgetRepository,
  ObligationRepository,
  SessionRepository,
  SourceRepository,
  UserRepository,
  createPool,
  migrate,
  withMigrationLock,
} from "../src/index.ts";
import {
  CredentialCipher,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
} from "@crashmemory/security";

const databaseUrl = process.env.TEST_DATABASE_URL;

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

test(
  "model budget reservations serialize concurrent attempts and keep unknown costs reserved",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!, { max: 4 });
    const userId = randomUUID();
    try {
      await migrate(pool);
      await new UserRepository(pool).create({
        id: userId,
        emailNormalized: `${userId}@example.test`,
        passwordHash: await hashPassword("synthetic-model-budget-password"),
        timeZone: "America/Bogota",
      });
      const budgets = new ModelBudgetRepository(pool);
      await budgets.setLimit({
        id: randomUUID(),
        userId,
        limitAmountUsd: "0.010000",
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
      });
      const reserve = (operationKey: string) =>
        budgets.reserve({
          id: randomUUID(),
          userId,
          operationKey,
          attemptNumber: 1,
          maximumCostUsd: "0.006000",
          provider: "openai",
          model: "gpt-5.6-terra",
          pricingVersion: "synthetic-v1",
          maximumInputUnits: 100,
          maximumOutputUnits: 100,
          now: new Date("2026-09-21T00:00:00Z"),
        });
      const concurrent = await Promise.allSettled([reserve("a"), reserve("b")]);
      const reserved = concurrent.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof reserve>>
        > => result.status === "fulfilled",
      );
      assert.equal(reserved.length, 1);
      await budgets.markUnknown({
        reservationId: reserved[0]!.value.id,
        userId,
        provider: "openai",
        model: "gpt-5.6-terra",
        pricingVersion: "synthetic-v1",
      });
      const usage = await pool.query<{ status: string; cost_amount: string }>(
        "SELECT status, cost_amount::text FROM model_usage_ledger WHERE user_id = $1 ORDER BY entry_sequence",
        [userId],
      );
      assert.deepEqual(
        usage.rows.map((row) => row.status),
        ["reserved", "unknown"],
      );
      assert.equal(usage.rows[1]?.cost_amount, "0.006000");
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  },
);

test(
  "a failed migration operation releases its transaction, lock and connection",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!, { max: 1 });
    try {
      await assert.rejects(
        withMigrationLock(pool, async (client) => {
          await client.query("BEGIN");
          await client.query("SELECT definitely_missing_column");
        }),
      );
      await withMigrationLock(pool, async (client) => {
        const result = await client.query<{ ok: number }>("SELECT 1 AS ok");
        assert.equal(result.rows[0]?.ok, 1);
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  "real repositories isolate two users and preserve evidence, money and civil dates",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    try {
      await migrate(pool);
      const users = new UserRepository(pool);
      const sources = new SourceRepository(pool);
      const userA = randomUUID();
      const userB = randomUUID();
      await users.create({
        id: userA,
        emailNormalized: `${userA}@example.test`,
        passwordHash: await hashPassword("synthetic-password-a"),
        timeZone: "America/Bogota",
      });
      await users.create({
        id: userB,
        emailNormalized: `${userB}@example.test`,
        passwordHash: await hashPassword("synthetic-password-b"),
        timeZone: "Europe/Madrid",
      });

      const connectionA = randomUUID();
      const connectionB = randomUUID();
      await sources.createConnection({
        id: connectionA,
        userId: userA,
        externalAccountId: "synthetic-a",
        state: "active",
      });
      await sources.createConnection({
        id: connectionB,
        userId: userB,
        externalAccountId: "synthetic-b",
        state: "active",
      });

      const originalBlobA = randomUUID();
      const bodyBlobA = randomUUID();
      const attachmentBlobA = randomUUID();
      await sources.createBlob({
        id: originalBlobA,
        userId: userA,
        storageKey: `users/${userA}/originals/message.eml`,
        contentType: "message/rfc822",
        byteSize: 100,
        contentSha256: "a".repeat(64),
      });
      await sources.createBlob({
        id: bodyBlobA,
        userId: userA,
        storageKey: `users/${userA}/bodies/message.txt`,
        contentType: "text/plain; charset=utf-8",
        byteSize: 30,
        contentSha256: "b".repeat(64),
      });
      await sources.createBlob({
        id: attachmentBlobA,
        userId: userA,
        storageKey: `users/${userA}/attachments/invoice.pdf`,
        contentType: "application/pdf",
        byteSize: 200,
        contentSha256: "c".repeat(64),
      });
      await assert.rejects(
        sources.createBlob({
          id: randomUUID(),
          userId: userB,
          storageKey: `users/${userA}/objects/cross-owner`,
          contentType: "text/plain",
          byteSize: 1,
          contentSha256: "d".repeat(64),
        }),
        /namespaced by owner/,
      );

      const itemA = randomUUID();
      const itemB = randomUUID();
      await sources.createItem({
        id: itemA,
        userId: userA,
        sourceConnectionId: connectionA,
        externalId: "msg-a",
      });
      await sources.createItem({
        id: itemB,
        userId: userB,
        sourceConnectionId: connectionB,
        externalId: "msg-b",
      });
      await assert.rejects(
        sources.createItem({
          id: randomUUID(),
          userId: userA,
          sourceConnectionId: connectionB,
          externalId: "cross-owner-connection",
        }),
        (error) => pgCode(error) === "23503",
      );
      const revisionA = randomUUID();
      await sources.createRevision({
        id: revisionA,
        userId: userA,
        sourceItemId: itemA,
        revision: 1,
        originalBlobId: originalBlobA,
        contentSha256: "a".repeat(64),
        observedAt: new Date("2026-09-20T12:00:00Z"),
      });
      await assert.rejects(
        sources.createRevision({
          id: randomUUID(),
          userId: userB,
          sourceItemId: itemB,
          revision: 1,
          originalBlobId: originalBlobA,
          contentSha256: "d".repeat(64),
          observedAt: new Date(),
        }),
        (error) => pgCode(error) === "23503",
      );

      await sources.createNormalizedBody({
        id: randomUUID(),
        userId: userA,
        sourceItemRevisionId: revisionA,
        bodyBlobId: bodyBlobA,
        contentSha256: "b".repeat(64),
        utf16Length: 30,
        normalizationVersion: "gmail-body-v1",
      });
      const attachmentA = randomUUID();
      await sources.createAttachment({
        id: attachmentA,
        userId: userA,
        sourceItemRevisionId: revisionA,
        externalAttachmentId: "attachment-a",
        blobId: attachmentBlobA,
        fileName: "invoice.pdf",
        mediaType: "application/pdf",
        byteSize: 200,
        contentSha256: "c".repeat(64),
      });
      const extraction = await sources.getExtractionInput(userA, revisionA);
      assert.equal(extraction?.body.blobId, bodyBlobA);
      assert.equal(extraction?.attachments[0]?.id, attachmentA);
      assert.equal(await sources.getExtractionInput(userB, revisionA), null);

      const evidenceA = randomUUID();
      await sources.createEvidence({
        id: evidenceA,
        userId: userA,
        sourceItemRevisionId: revisionA,
        kind: "email_body_fragment",
        startOffset: 0,
        endOffset: 7,
        quote: "Factura",
        contentSha256: "b".repeat(64),
      });
      assert.equal(
        (await sources.getEvidence(userA, evidenceA))?.id,
        evidenceA,
      );
      assert.equal(await sources.getEvidence(userB, evidenceA), null);
      await assert.rejects(
        sources.createEvidence({
          id: randomUUID(),
          userId: userB,
          sourceItemRevisionId: revisionA,
          kind: "email_body_fragment",
          startOffset: 0,
          endOffset: 4,
          quote: "test",
          contentSha256: "b".repeat(64),
        }),
        (error) => pgCode(error) === "23503",
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO evidence(
           id, user_id, source_item_revision_id, kind, attachment_id, start_offset,
           end_offset, quote, content_sha256
         ) VALUES ($1, $2, $3, 'pdf_text_fragment', $4, 0, 4, 'test', $5)`,
          [randomUUID(), userA, revisionA, attachmentA, "c".repeat(64)],
        ),
        (error) => pgCode(error) === "23514",
      );

      const obligationId = randomUUID();
      const versionId = randomUUID();
      const obligationRepo = new ObligationRepository(pool);
      await obligationRepo.createCandidate({
        id: obligationId,
        versionId,
        userId: userA,
        title: "Factura sintética",
        amount: { amount: "9007199254740993.1200", currency: "COP" },
        due: {
          kind: "civil_date",
          date: "2026-10-15",
          timeZone: "America/Bogota",
        },
        evidenceIds: [evidenceA],
        outboxEvent: {
          id: randomUUID(),
          userId: userA,
          type: "obligation.candidate.created.v1",
          aggregateType: "obligation",
          aggregateId: obligationId,
          idempotencyKey: `candidate:${obligationId}`,
          occurredAt: "2026-09-20T12:00:00Z",
          payload: { obligationId, sourceItemRevisionId: revisionA },
        },
      });
      const summary = await obligationRepo.getSummary(userA, obligationId);
      assert.equal(summary?.amount?.amount, "9007199254740993.12");
      assert.deepEqual(summary?.due, {
        kind: "civil_date",
        date: "2026-10-15",
        timeZone: "America/Bogota",
      });
      assert.equal(await obligationRepo.getSummary(userB, obligationId), null);
      await assert.rejects(
        obligationRepo.createCandidate({
          id: randomUUID(),
          versionId: randomUUID(),
          userId: userA,
          title: "Sin evidencia",
          evidenceIds: [],
          outboxEvent: {
            id: randomUUID(),
            userId: userA,
            type: "obligation.candidate.created.v1",
            aggregateType: "obligation",
            aggregateId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: "2026-09-20T12:00:00Z",
            payload: {
              obligationId: randomUUID(),
              sourceItemRevisionId: revisionA,
            },
          },
        }),
        /at least one/,
      );
      const overPrecisionObligation = randomUUID();
      await assert.rejects(
        obligationRepo.createCandidate({
          id: overPrecisionObligation,
          versionId: randomUUID(),
          userId: userA,
          title: "Precisión inválida",
          amount: { amount: "1.1234567890123456789", currency: "COP" },
          evidenceIds: [evidenceA],
          outboxEvent: {
            id: randomUUID(),
            userId: userA,
            type: "obligation.candidate.created.v1",
            aggregateType: "obligation",
            aggregateId: overPrecisionObligation,
            idempotencyKey: randomUUID(),
            occurredAt: "2026-09-20T12:00:00Z",
            payload: {
              obligationId: overPrecisionObligation,
              sourceItemRevisionId: revisionA,
            },
          },
        }),
        (error) => pgCode(error) === "23514",
      );
      const nanObligation = randomUUID();
      await pool.query("INSERT INTO obligations(id, user_id) VALUES ($1, $2)", [
        nanObligation,
        userA,
      ]);
      await assert.rejects(
        pool.query(
          `INSERT INTO obligation_versions(
           id, user_id, obligation_id, revision, title, amount, currency
         ) VALUES ($1, $2, $3, 1, 'NaN inválido', 'NaN'::numeric, 'COP')`,
          [randomUUID(), userA, nanObligation],
        ),
        (error) => pgCode(error) === "23514",
      );
      await assert.rejects(
        pool.query("UPDATE evidence SET quote = 'mutated' WHERE id = $1", [
          evidenceA,
        ]),
        (error) => pgCode(error) === "55000",
      );

      const cipher = new CredentialCipher(
        "v1",
        new Map([["v1", randomBytes(32)]]),
      );
      const context = `${userA}:${connectionA}`;
      await sources.storeCredential({
        id: randomUUID(),
        userId: userA,
        sourceConnectionId: connectionA,
        encrypted: cipher.encrypt("synthetic-provider-token", context),
      });
      const encrypted = await sources.getCredential(userA, connectionA);
      assert.ok(encrypted);
      assert.equal(
        cipher.decrypt(encrypted, context),
        "synthetic-provider-token",
      );
      assert.equal(await sources.getCredential(userB, connectionA), null);

      const sessionId = randomUUID();
      await new SessionRepository(pool).create({
        id: sessionId,
        userId: userA,
        tokenHash: hashOpaqueToken(generateOpaqueToken()),
        csrfTokenHash: hashOpaqueToken(generateOpaqueToken()),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const oauth = new OAuthCallbackRepository(pool);
      const nonceHash = hashOpaqueToken(generateOpaqueToken());
      await oauth.create({
        id: randomUUID(),
        userId: userA,
        authSessionId: sessionId,
        provider: "gmail",
        nonceHash,
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.equal(
        await oauth.consume({
          userId: userA,
          authSessionId: sessionId,
          provider: "gmail",
          nonceHash,
        }),
        true,
      );
      assert.equal(
        await oauth.consume({
          userId: userA,
          authSessionId: sessionId,
          provider: "gmail",
          nonceHash,
        }),
        false,
      );

      const validEventId = randomUUID();
      await pool.query(
        `INSERT INTO outbox_events(
         id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key, occurred_at, payload
       ) VALUES ($1, $2, 'test.valid.v1', 'test', $3, $4, now(), '{}')`,
        [validEventId, userA, randomUUID(), randomUUID()],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO outbox_events(
           id, user_id, event_type, aggregate_type, aggregate_id, idempotency_key, occurred_at, payload
         ) VALUES ($1, $2, 'test.invalid', 'test', $3, $4, now(), '{}')`,
          [randomUUID(), userA, randomUUID(), randomUUID()],
        ),
        (error) => pgCode(error) === "23514",
      );

      await pool.query("DELETE FROM users WHERE id = $1", [userB]);
      assert.equal(await users.findById(userB), null);
      await pool.query("DELETE FROM users WHERE id = $1", [userA]);
      assert.equal(await users.findById(userA), null);
    } finally {
      await pool.end();
    }
  },
);
