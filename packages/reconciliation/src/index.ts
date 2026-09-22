import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  DueValueSchema,
  MoneySchema,
  type DueValue,
  type Money,
  type OutboxEvent,
} from "@crashmemory/contracts";
import { inTransaction } from "@crashmemory/db";
import type { ConsumerRegistry } from "@crashmemory/runtime";

export type ObligationState =
  "candidate" | "confirmed" | "conflict" | "paid" | "discarded";
export interface Fields {
  title: string;
  amount: Money;
  due: DueValue;
}
export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "stale_version"
      | "invalid_transition"
      | "conflict_not_found",
    message: string,
  ) {
    super(message);
  }
}
type Row = Record<string, unknown>;
const str = (value: unknown) => String(value);
const normalized = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const decimal = (value: string) => {
  const [integer, fraction = ""] = value.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole;
};
const sameFields = (left: Fields, right: Fields) =>
  left.title === right.title &&
  left.amount.currency === right.amount.currency &&
  decimal(left.amount.amount) === decimal(right.amount.amount) &&
  same(left.due, right.due);

export function verifiedIdentityHash(
  identity: unknown,
  quotes: string[],
): string | null {
  if (!identity || typeof identity !== "object") return null;
  const value = identity as { issuer?: unknown; reference?: unknown };
  if (typeof value.issuer !== "string" || typeof value.reference !== "string")
    return null;
  const issuer = normalized(value.issuer);
  const reference = normalized(value.reference);
  if (
    issuer.length < 3 ||
    reference.length < 4 ||
    !/[a-z]/i.test(issuer) ||
    !/[0-9a-z]/i.test(reference)
  )
    return null;
  const token = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const issuerPattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${token(issuer)}(?=$|[^\\p{L}\\p{N}])`,
    "u",
  );
  const invoicePattern = new RegExp(
    `\\b(?:factura|invoice|recibo|receipt|liquidaci[oó]n)\\s*(?:(?:n[°ºo.]?|no\\.?|n[uú]mero|number|ref(?:erencia)?|#)\\s*[:#.-]?\\s*)?(${token(reference)})(?=$|[^\\p{L}\\p{N}_./-])`,
    "u",
  );
  if (
    !quotes.some((quote) => {
      const text = normalized(quote);
      const match = invoicePattern.exec(text);
      return (
        issuerPattern.test(text) &&
        match !== null &&
        (match.index === 0 || !/[\p{L}\p{N}]/u.test(text[match.index - 1]!))
      );
    })
  )
    return null;
  return createHash("sha256")
    .update(JSON.stringify([issuer, reference]))
    .digest("hex");
}

function fieldsFromRow(row: Row): Fields {
  const due =
    row.due_kind === "civil_date"
      ? {
          kind: "civil_date",
          date: str(row.due_date),
          timeZone: str(row.time_zone),
        }
      : {
          kind: "instant",
          at: (row.due_at as Date).toISOString(),
          timeZone: str(row.time_zone),
        };
  return {
    title: str(row.title),
    amount: MoneySchema.parse({
      amount: str(row.amount),
      currency: str(row.currency),
    }),
    due: DueValueSchema.parse(due),
  };
}

function dueColumns(
  due: DueValue,
): [string, string | null, string | null, string] {
  return due.kind === "civil_date"
    ? ["civil_date", due.date, null, due.timeZone]
    : ["instant", null, due.at, due.timeZone];
}

async function appendEvent(
  client: PoolClient,
  input: {
    userId: string;
    obligationId: string;
    type: string;
    key: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events(id,user_id,event_type,aggregate_type,aggregate_id,idempotency_key,occurred_at,payload)
     VALUES ($1,$2,$3,'obligation',$4,$5,now(),$6)`,
    [
      randomUUID(),
      input.userId,
      input.type,
      input.obligationId,
      input.key,
      input.payload,
    ],
  );
}

async function createVersion(
  client: PoolClient,
  input: {
    userId: string;
    obligationId: string;
    revision: number;
    state: ObligationState;
    fields: Fields;
    evidenceIds: string[];
    cause?: "due_changed" | "paid" | "discarded" | "conflict";
  },
): Promise<string> {
  if (input.evidenceIds.length === 0)
    throw new Error("A version requires evidence");
  const id = randomUUID();
  const [kind, date, at, zone] = dueColumns(input.fields.due);
  await client.query(
    `INSERT INTO obligation_versions(id,user_id,obligation_id,revision,title,amount,currency,due_kind,due_date,due_at,time_zone,state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.userId,
      input.obligationId,
      input.revision,
      input.fields.title,
      input.fields.amount.amount,
      input.fields.amount.currency,
      kind,
      date,
      at,
      zone,
      input.state,
    ],
  );
  for (const evidenceId of [...new Set(input.evidenceIds)]) {
    await client.query(
      `INSERT INTO obligation_version_evidence(user_id,obligation_version_id,evidence_id)
       VALUES ($1,$2,$3)`,
      [input.userId, id, evidenceId],
    );
  }
  await client.query(
    `UPDATE obligations SET current_version_id=$3,state=$4,updated_at=now() WHERE id=$1 AND user_id=$2`,
    [input.obligationId, input.userId, id, input.state],
  );
  await appendEvent(client, {
    userId: input.userId,
    obligationId: input.obligationId,
    type: "obligation.version.created.v1",
    key: `obligation-version:${id}`,
    payload: {
      obligationId: input.obligationId,
      obligationVersionId: id,
      revision: input.revision,
    },
  });
  if (input.cause) {
    await appendEvent(client, {
      userId: input.userId,
      obligationId: input.obligationId,
      type: "obligation.reminder.reschedule.requested.v1",
      key: `obligation-reschedule:${id}`,
      payload: { obligationId: input.obligationId, cause: input.cause },
    });
  }
  return id;
}

async function evidenceForCandidate(
  client: PoolClient,
  userId: string,
  candidateId: string,
): Promise<Array<{ id: string; quote: string }>> {
  const found = await client.query<{ id: string; quote: string }>(
    `SELECT e.id,e.quote FROM extraction_candidate_evidence ce
     JOIN evidence e ON e.id=ce.evidence_id AND e.user_id=ce.user_id
     WHERE ce.candidate_id=$1 AND ce.user_id=$2 ORDER BY e.id`,
    [candidateId, userId],
  );
  return found.rows;
}

async function evidenceForVersion(
  client: PoolClient,
  userId: string,
  versionId: string,
): Promise<string[]> {
  const found = await client.query<{ evidence_id: string }>(
    `SELECT evidence_id FROM obligation_version_evidence
     WHERE user_id=$1 AND obligation_version_id=$2 ORDER BY evidence_id`,
    [userId, versionId],
  );
  return found.rows.map((row) => row.evidence_id);
}

async function current(
  client: PoolClient,
  userId: string,
  obligationId: string,
): Promise<Row> {
  const found = await client.query<Row>(
    `SELECT o.id,o.state,o.current_version_id,o.latest_identity_observed_at,o.conflict_origin_state,
       v.revision,v.title,v.amount::text AS amount,v.currency,v.due_kind,
       v.due_date::text AS due_date,v.due_at,v.time_zone
     FROM obligations o JOIN obligation_versions v ON v.id=o.current_version_id
     WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE OF o`,
    [obligationId, userId],
  );
  if (!found.rows[0])
    throw new ReconciliationError("not_found", "Obligation not found");
  return found.rows[0];
}

async function insertConflict(
  client: PoolClient,
  input: {
    userId: string;
    obligationId: string;
    candidateId: string;
    sourceRevisionId: string;
    reason:
      | "protected_field"
      | "out_of_order"
      | "terminal_state"
      | "unresolved_conflict";
    fields: Fields;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO obligation_conflicts(id,user_id,obligation_id,candidate_id,source_item_revision_id,reason,proposal)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (candidate_id) DO NOTHING`,
    [
      randomUUID(),
      input.userId,
      input.obligationId,
      input.candidateId,
      input.sourceRevisionId,
      input.reason,
      input.fields,
    ],
  );
}

export class ReconciliationService {
  constructor(private readonly pool: Pool) {}

  /** Called with V03's receipt PoolClient; all effects commit with the receipt. */
  async consumeCandidate(
    event: Extract<OutboxEvent, { type: "obligation.candidate.created.v1" }>,
    client: PoolClient,
  ): Promise<void> {
    const candidateId = event.payload.obligationId;
    const loaded = await client.query<Row>(
      `SELECT c.*,r.observed_at FROM extraction_candidates c
       JOIN source_item_revisions r ON r.id=c.source_item_revision_id AND r.user_id=c.user_id
       WHERE c.id=$1 AND c.user_id=$2 AND c.source_item_revision_id=$3 AND c.state='ready'`,
      [candidateId, event.userId, event.payload.sourceItemRevisionId],
    );
    const candidate = loaded.rows[0];
    if (!candidate) throw new Error("Candidate is unavailable or not ready");
    const evidence = await evidenceForCandidate(
      client,
      event.userId,
      candidateId,
    );
    if (!evidence.length) throw new Error("Candidate has no evidence");
    const identityHash = verifiedIdentityHash(
      candidate.identity,
      evidence.map((item) => item.quote),
    );
    const fields: Fields = {
      title: str(candidate.title),
      amount: MoneySchema.parse({
        amount: str(candidate.amount),
        currency: str(candidate.currency),
      }),
      due: DueValueSchema.parse(candidate.due),
    };
    if (identityHash) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${event.userId}:${identityHash}`],
      );
    }
    const priorLink = await client.query(
      "SELECT 1 FROM reconciliation_candidate_links WHERE candidate_id=$1",
      [candidateId],
    );
    if (priorLink.rowCount) return;
    const found = identityHash
      ? await client.query<{ id: string }>(
          `SELECT id FROM obligations WHERE user_id=$1 AND identity_hash=$2 FOR UPDATE`,
          [event.userId, identityHash],
        )
      : { rows: [] as Array<{ id: string }> };
    let obligationId = found.rows[0]?.id;
    if (!obligationId) {
      obligationId = randomUUID();
      await client.query(
        `INSERT INTO obligations(id,user_id,state,identity_hash,latest_identity_observed_at)
         VALUES ($1,$2,'candidate',$3,$4)`,
        [
          obligationId,
          event.userId,
          identityHash,
          identityHash ? candidate.observed_at : null,
        ],
      );
      await createVersion(client, {
        userId: event.userId,
        obligationId,
        revision: 1,
        state: "candidate",
        fields,
        evidenceIds: evidence.map((item) => item.id),
      });
    } else {
      const row = await current(client, event.userId, obligationId);
      const oldFields = fieldsFromRow(row);
      const oldState = str(row.state) as ObligationState;
      const observedAt = candidate.observed_at as Date;
      const latestAt = row.latest_identity_observed_at as Date | null;
      const changed = !sameFields(oldFields, fields);
      if (oldState === "paid" || oldState === "discarded") {
        await insertConflict(client, {
          userId: event.userId,
          obligationId,
          candidateId,
          sourceRevisionId: str(candidate.source_item_revision_id),
          reason: "terminal_state",
          fields,
        });
      } else if (latestAt && observedAt <= latestAt && changed) {
        // A late extraction may be old information. Keep the live version and reminders.
        await insertConflict(client, {
          userId: event.userId,
          obligationId,
          candidateId,
          sourceRevisionId: str(candidate.source_item_revision_id),
          reason: "out_of_order",
          fields,
        });
      } else if (oldState === "conflict") {
        if (changed)
          await insertConflict(client, {
            userId: event.userId,
            obligationId,
            candidateId,
            sourceRevisionId: str(candidate.source_item_revision_id),
            reason: "unresolved_conflict",
            fields,
          });
      } else {
        const protectedFields = await client.query<{ field_name: string }>(
          `SELECT DISTINCT field_name FROM field_corrections WHERE obligation_id=$1 AND user_id=$2`,
          [obligationId, event.userId],
        );
        const protectedSet = new Set(
          protectedFields.rows.map((item) => item.field_name),
        );
        const violation =
          (protectedSet.has("title") && oldFields.title !== fields.title) ||
          (protectedSet.has("amount") &&
            (oldFields.amount.currency !== fields.amount.currency ||
              decimal(oldFields.amount.amount) !==
                decimal(fields.amount.amount))) ||
          (protectedSet.has("due") && !same(oldFields.due, fields.due));
        if (violation) {
          await insertConflict(client, {
            userId: event.userId,
            obligationId,
            candidateId,
            sourceRevisionId: str(candidate.source_item_revision_id),
            reason: "protected_field",
            fields,
          });
          await client.query(
            "UPDATE obligations SET conflict_origin_state=$3 WHERE id=$1 AND user_id=$2",
            [obligationId, event.userId, oldState],
          );
          await createVersion(client, {
            userId: event.userId,
            obligationId,
            revision: Number(row.revision) + 1,
            state: "conflict",
            fields: oldFields,
            evidenceIds: await evidenceForVersion(
              client,
              event.userId,
              str(row.current_version_id),
            ),
            cause: "conflict",
          });
        } else if (changed) {
          await createVersion(client, {
            userId: event.userId,
            obligationId,
            revision: Number(row.revision) + 1,
            state: oldState,
            fields,
            evidenceIds: evidence.map((item) => item.id),
            cause: !same(oldFields.due, fields.due) ? "due_changed" : undefined,
          });
        }
        if (!latestAt || observedAt > latestAt) {
          await client.query(
            "UPDATE obligations SET latest_identity_observed_at=$3 WHERE id=$1 AND user_id=$2",
            [obligationId, event.userId, observedAt],
          );
        }
      }
    }
    await client.query(
      `INSERT INTO reconciliation_candidate_links(candidate_id,user_id,source_item_revision_id,obligation_id)
       VALUES ($1,$2,$3,$4)`,
      [
        candidateId,
        event.userId,
        candidate.source_item_revision_id,
        obligationId,
      ],
    );
  }

  async mutate(input: {
    userId: string;
    sessionId: string;
    obligationId: string;
    expectedVersion: number;
    action: "confirm" | "correct" | "pay" | "discard" | "resolve";
    changes?: Partial<Fields>;
    conflictId?: string;
    resolution?: "accept" | "reject";
  }): Promise<{ state: ObligationState; versionId: string; revision: number }> {
    return inTransaction(this.pool, async (client) => {
      const row = await current(client, input.userId, input.obligationId);
      if (Number(row.revision) !== input.expectedVersion)
        throw new ReconciliationError(
          "stale_version",
          "Expected version is obsolete",
        );
      const state = str(row.state) as ObligationState;
      const oldFields = fieldsFromRow(row);
      let fields = oldFields;
      let nextState: ObligationState = state;
      let evidenceIds = await evidenceForVersion(
        client,
        input.userId,
        str(row.current_version_id),
      );
      let cause: "due_changed" | "paid" | "discarded" | "conflict" | undefined;
      let protect = false;
      if (input.action === "confirm") {
        if (state !== "candidate")
          throw new ReconciliationError(
            "invalid_transition",
            "Only a candidate can be confirmed",
          );
        nextState = "confirmed";
        protect = true;
      } else if (input.action === "correct") {
        if (state !== "candidate" && state !== "confirmed")
          throw new ReconciliationError(
            "invalid_transition",
            "This obligation cannot be corrected",
          );
        if (!input.changes || Object.keys(input.changes).length === 0)
          throw new ReconciliationError(
            "invalid_transition",
            "At least one field is required",
          );
        fields = { ...oldFields, ...input.changes };
        fields = {
          title: fields.title,
          amount: MoneySchema.parse(fields.amount),
          due: DueValueSchema.parse(fields.due),
        };
        if (fields.title.length < 1 || fields.title.length > 500)
          throw new ReconciliationError(
            "invalid_transition",
            "Title is invalid",
          );
        protect = true;
        if (!same(oldFields.due, fields.due)) cause = "due_changed";
      } else if (input.action === "pay") {
        if (state !== "confirmed")
          throw new ReconciliationError(
            "invalid_transition",
            "Only a confirmed obligation can be paid",
          );
        nextState = "paid";
        cause = "paid";
      } else if (input.action === "discard") {
        if (state === "paid" || state === "discarded")
          throw new ReconciliationError(
            "invalid_transition",
            "Terminal obligation cannot be discarded",
          );
        nextState = "discarded";
        cause = "discarded";
      } else {
        if (!input.conflictId || !input.resolution)
          throw new ReconciliationError(
            "conflict_not_found",
            "Conflict was not found",
          );
        const conflict = await client.query<Row>(
          `SELECT * FROM obligation_conflicts WHERE id=$1 AND user_id=$2 AND obligation_id=$3 AND state='open' FOR UPDATE`,
          [input.conflictId, input.userId, input.obligationId],
        );
        const proposal = conflict.rows[0];
        if (!proposal)
          throw new ReconciliationError(
            "conflict_not_found",
            "Conflict was not found",
          );
        if (state === "paid" || state === "discarded") {
          if (input.resolution === "accept")
            throw new ReconciliationError(
              "invalid_transition",
              "Terminal obligation cannot be resurrected",
            );
        } else if (input.resolution === "accept") {
          const raw = proposal.proposal as Fields;
          fields = {
            title: raw.title,
            amount: MoneySchema.parse(raw.amount),
            due: DueValueSchema.parse(raw.due),
          };
          evidenceIds = (
            await evidenceForCandidate(
              client,
              input.userId,
              str(proposal.candidate_id),
            )
          ).map((item) => item.id);
          protect = true;
        }
        await client.query(
          `UPDATE obligation_conflicts SET state=$4,resolved_at=now()
           WHERE id=$1 AND user_id=$2 AND obligation_id=$3`,
          [
            input.conflictId,
            input.userId,
            input.obligationId,
            input.resolution === "accept" ? "accepted" : "rejected",
          ],
        );
        if (state === "conflict") {
          const more = await client.query(
            `SELECT 1 FROM obligation_conflicts WHERE obligation_id=$1 AND user_id=$2 AND state='open' LIMIT 1`,
            [input.obligationId, input.userId],
          );
          nextState = more.rowCount
            ? "conflict"
            : (str(
                row.conflict_origin_state ?? "candidate",
              ) as ObligationState);
          if (!more.rowCount) {
            await client.query(
              "UPDATE obligations SET conflict_origin_state=NULL WHERE id=$1 AND user_id=$2",
              [input.obligationId, input.userId],
            );
          }
        }
        if (!same(oldFields.due, fields.due)) cause = "due_changed";
      }
      const versionId = await createVersion(client, {
        userId: input.userId,
        obligationId: input.obligationId,
        revision: input.expectedVersion + 1,
        state: nextState,
        fields,
        evidenceIds,
        cause,
      });
      if (protect) {
        const names: Array<keyof Fields> =
          input.action === "correct"
            ? (Object.keys(input.changes ?? {}) as Array<keyof Fields>)
            : ["title", "amount", "due"];
        for (const field of names) {
          await client.query(
            `INSERT INTO field_corrections(id,user_id,obligation_id,based_on_version_id,field_name,corrected_value)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              randomUUID(),
              input.userId,
              input.obligationId,
              versionId,
              field,
              JSON.stringify(fields[field]),
            ],
          );
        }
      }
      await client.query(
        `INSERT INTO audit_ledger_entries(id,user_id,actor_session_id,action,target_type,target_id,details)
         VALUES ($1,$2,$3,$4,'obligation',$5,$6)`,
        [
          randomUUID(),
          input.userId,
          input.sessionId,
          `obligation.${input.action}`,
          input.obligationId,
          {
            expectedVersion: input.expectedVersion,
            nextVersion: input.expectedVersion + 1,
          },
        ],
      );
      return {
        state: nextState,
        versionId,
        revision: input.expectedVersion + 1,
      };
    });
  }
}

export function registerReconciliationConsumer(
  registry: ConsumerRegistry,
  service: ReconciliationService,
): void {
  registry.register({
    name: "reconciliation.candidate.v1",
    eventTypes: ["obligation.candidate.created.v1"],
    handle: async (event, client) => {
      if (event.type !== "obligation.candidate.created.v1")
        throw new Error("Unexpected reconciliation event");
      await service.consumeCandidate(event, client);
    },
  });
}
