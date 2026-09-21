import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  DueValueSchema,
  EvidenceReferenceSchema,
  MoneySchema,
  OutboxEventSchema,
  demoObligation,
} from "../src/index.ts";

test("the demo contract preserves decimal money and a civil due date", () => {
  assert.equal(CONTRACT_VERSION, "2026-09-20.v1");
  assert.deepEqual(demoObligation.amount, {
    amount: "48250.00",
    currency: "COP",
  });
  assert.deepEqual(demoObligation.due, {
    kind: "civil_date",
    date: "2026-10-15",
    timeZone: "America/Bogota",
  });
});

test("runtime schemas reject floating money, invalid calendar dates and incomplete PDF evidence", () => {
  assert.equal(
    MoneySchema.safeParse({ amount: 48250, currency: "COP" }).success,
    false,
  );
  assert.equal(
    MoneySchema.safeParse({ amount: "48250.00", currency: "cop" }).success,
    false,
  );
  assert.equal(
    MoneySchema.safeParse({ amount: "0.00", currency: "COP" }).success,
    false,
  );
  assert.equal(
    DueValueSchema.safeParse({
      kind: "civil_date",
      date: "2026-02-30",
      timeZone: "America/Bogota",
    }).success,
    false,
  );
  assert.equal(
    EvidenceReferenceSchema.safeParse({
      id: "ev_1",
      sourceItemRevisionId: "sir_1",
      kind: "pdf_text_fragment",
      startOffset: 0,
      endOffset: 4,
      quote: "test",
      contentSha256: "a".repeat(64),
    }).success,
    false,
  );
});

test("runtime event envelope rejects unversioned or mismatched payloads", () => {
  assert.equal(
    OutboxEventSchema.safeParse({
      id: "evt_1",
      type: "obligation.version.created.v1",
      occurredAt: "2026-09-20T12:00:00Z",
      userId: "usr_1",
      idempotencyKey: "event:1",
      aggregateType: "obligation",
      aggregateId: "obl_1",
      payload: {
        obligationId: "obl_1",
        obligationVersionId: "obv_1",
        revision: 1,
      },
    }).success,
    true,
  );
  assert.equal(
    OutboxEventSchema.safeParse({
      id: "evt_1",
      type: "obligation.version.created",
      occurredAt: "2026-09-20T12:00:00Z",
      userId: "usr_1",
      idempotencyKey: "event:1",
      aggregateType: "obligation",
      aggregateId: "obl_1",
      payload: {},
    }).success,
    false,
  );
});
