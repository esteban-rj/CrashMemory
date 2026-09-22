import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { DueValueSchema, MoneySchema } from "@crashmemory/contracts";
import {
  ReconciliationError,
  ReconciliationService,
  type Fields,
} from "@crashmemory/reconciliation";
import {
  AuthorizedBlobStorage,
  type ObjectStorage,
} from "@crashmemory/runtime";
import { SourceRepository } from "@crashmemory/db";
import {
  isTrustedOrigin,
  resolveSession,
  verifySessionCsrf,
  type AuthConfig,
} from "./auth.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error = (request: FastifyRequest, code: string, message: string) => ({
  error: { code, message, requestId: request.id },
});
type Row = Record<string, unknown>;
const str = (value: unknown) => String(value);
function version(row: Row) {
  return {
    id: str(row.id),
    revision: Number(row.revision),
    state: row.state,
    title: row.title,
    amount: { amount: str(row.amount), currency: row.currency },
    due:
      row.due_kind === "civil_date"
        ? {
            kind: "civil_date",
            date: str(row.due_date),
            timeZone: row.time_zone,
          }
        : {
            kind: "instant",
            at: (row.due_at as Date).toISOString(),
            timeZone: row.time_zone,
          },
    createdAt: (row.created_at as Date).toISOString(),
  };
}
const selectVersion = `SELECT id,revision,state,title,amount::text AS amount,currency,due_kind,
  due_date::text AS due_date,due_at,time_zone,created_at FROM obligation_versions`;

function parseCursor(
  value: unknown,
): { updatedAt: string; id: string } | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const data = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Row;
    if (
      typeof data.updatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::\d{2})?)?$/.test(
        data.updatedAt,
      ) ||
      typeof data.id !== "string" ||
      !uuid.test(data.id)
    )
      return null;
    return { updatedAt: data.updatedAt, id: data.id };
  } catch {
    return null;
  }
}

export function registerObligationRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: AuthConfig,
  storage?: ObjectStorage,
): void {
  const service = new ReconciliationService(pool);
  const blobs = storage
    ? new AuthorizedBlobStorage(storage, new SourceRepository(pool))
    : null;
  const readSession = async (
    request: FastifyRequest,
    reply: { code: (status: number) => { send: (data: unknown) => unknown } },
  ) => {
    const session = await resolveSession(request, pool, auth);
    if (!session) {
      reply
        .code(401)
        .send(
          error(request, "authentication_required", "Authentication required"),
        );
      return null;
    }
    return session;
  };
  app.get("/api/v1/extraction/reviews", async (request, reply) => {
    const session = await readSession(request, reply);
    if (!session) return;
    const query = request.query as { limit?: unknown; cursor?: unknown };
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    const cursor = parseCursor(query.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === null)
      return reply
        .code(400)
        .send(error(request, "invalid_pagination", "Pagination is invalid"));
    const jobs = await pool.query<Row>(
      `SELECT id,source_item_revision_id,state,last_error_code,created_at::text AS cursor_created_at,
         created_at,completed_at FROM extraction_jobs
       WHERE user_id=$1 AND state IN ('manual_review','failed')
         AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [
        session.userId,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = jobs.rows.slice(0, limit);
    const codes = new Set([
      "pdf_requires_manual_review",
      "ambiguous_candidate",
      "unsupported_currency",
      "missing_verifiable_fields",
      "invalid_evidence",
      "input_unavailable",
      "lease_expired",
      "no_candidate",
    ]);
    const last = page.at(-1);
    return reply.send({
      data: page.map((row) => ({
        id: row.id,
        sourceItemRevisionId: row.source_item_revision_id,
        state: row.state,
        reasonCode: codes.has(str(row.last_error_code))
          ? row.last_error_code
          : "extraction_unavailable",
        createdAt: (row.created_at as Date).toISOString(),
        completedAt: row.completed_at
          ? (row.completed_at as Date).toISOString()
          : null,
      })),
      meta: {
        nextCursor:
          jobs.rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  updatedAt: last.cursor_created_at,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      },
    });
  });
  app.get("/api/v1/obligations", async (request, reply) => {
    const session = await readSession(request, reply);
    if (!session) return;
    const query = request.query as {
      limit?: unknown;
      cursor?: unknown;
      state?: unknown;
    };
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    const cursor = parseCursor(query.cursor);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      cursor === null ||
      (query.state !== undefined &&
        !["candidate", "confirmed", "conflict", "paid", "discarded"].includes(
          str(query.state),
        ))
    )
      return reply
        .code(400)
        .send(
          error(
            request,
            "invalid_pagination",
            "Pagination or state is invalid",
          ),
        );
    const result = await pool.query<Row>(
      `SELECT o.id AS obligation_id,o.state AS obligation_state,o.updated_at::text AS cursor_updated_at,
         v.id,v.revision,v.state,v.title,v.amount::text AS amount,v.currency,v.due_kind,
         v.due_date::text AS due_date,v.due_at,v.time_zone,v.created_at
       FROM obligations o JOIN obligation_versions v ON v.id=o.current_version_id
       WHERE o.user_id=$1 AND ($2::obligation_state IS NULL OR o.state=$2)
         AND ($3::timestamptz IS NULL OR (o.updated_at,o.id)<($3,$4::uuid))
       ORDER BY o.updated_at DESC,o.id DESC LIMIT $5`,
      [
        session.userId,
        query.state ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return reply.send({
      data: page.map((row) => ({
        ...version(row),
        obligationId: row.obligation_id,
        state: row.obligation_state,
      })),
      meta: {
        nextCursor:
          result.rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  updatedAt: last.cursor_updated_at,
                  id: last.obligation_id,
                }),
              ).toString("base64url")
            : null,
      },
    });
  });

  app.get("/api/v1/obligations/:id", async (request, reply) => {
    const session = await readSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    if (!uuid.test(id))
      return reply
        .code(400)
        .send(error(request, "invalid_id", "Identifier is invalid"));
    const obligation = await pool.query<Row>(
      "SELECT id,state,current_version_id,created_at,updated_at FROM obligations WHERE id=$1 AND user_id=$2",
      [id, session.userId],
    );
    if (!obligation.rows[0])
      return reply
        .code(404)
        .send(error(request, "not_found", "Obligation not found"));
    const versions = await pool.query<Row>(
      `${selectVersion} WHERE obligation_id=$1 AND user_id=$2 ORDER BY revision DESC`,
      [id, session.userId],
    );
    const evidences = await pool.query<Row>(
      `SELECT ve.obligation_version_id,e.id,e.kind,e.source_item_revision_id,e.attachment_id,e.page,
         e.start_offset,e.end_offset,e.quote,e.content_sha256
       FROM obligation_version_evidence ve JOIN evidence e ON e.id=ve.evidence_id AND e.user_id=ve.user_id
       JOIN obligation_versions v ON v.id=ve.obligation_version_id AND v.user_id=ve.user_id
       WHERE v.obligation_id=$1 AND ve.user_id=$2 ORDER BY v.revision DESC,e.id`,
      [id, session.userId],
    );
    const conflicts = await pool.query<Row>(
      `SELECT c.id,c.reason,c.state,c.proposal,c.candidate_id,c.created_at,c.resolved_at,
         array_agg(e.id ORDER BY e.id) AS evidence_ids
       FROM obligation_conflicts c JOIN extraction_candidate_evidence ce ON ce.candidate_id=c.candidate_id AND ce.user_id=c.user_id
       JOIN evidence e ON e.id=ce.evidence_id AND e.user_id=ce.user_id
       WHERE c.obligation_id=$1 AND c.user_id=$2
       GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC`,
      [id, session.userId],
    );
    const corrections = await pool.query<Row>(
      `SELECT field_name,corrected_value,created_at,based_on_version_id
       FROM field_corrections WHERE obligation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC`,
      [id, session.userId],
    );
    const protectedFields = [
      ...new Map(
        corrections.rows.toReversed().map((item) => [
          item.field_name,
          {
            field: item.field_name,
            value: item.corrected_value,
            basedOnVersionId: item.based_on_version_id,
            correctedAt: (item.created_at as Date).toISOString(),
          },
        ]),
      ).values(),
    ];
    const base = obligation.rows[0];
    return reply.send({
      data: {
        id,
        state: base.state,
        currentVersionId: base.current_version_id,
        createdAt: (base.created_at as Date).toISOString(),
        updatedAt: (base.updated_at as Date).toISOString(),
        versions: versions.rows.map((row) => ({
          ...version(row),
          evidence: evidences.rows
            .filter((item) => item.obligation_version_id === row.id)
            .map((item) => ({
              id: item.id,
              kind: item.kind,
              sourceItemRevisionId: item.source_item_revision_id,
              attachmentId: item.attachment_id,
              page: item.page,
              startOffset: item.start_offset,
              endOffset: item.end_offset,
              quote: item.quote,
              contentSha256: item.content_sha256,
              url: `/api/v1/evidence/${item.id}`,
            })),
        })),
        protectedFields,
        conflicts: conflicts.rows.map((item) => ({
          id: item.id,
          reason: item.reason,
          state: item.state,
          proposal: item.proposal,
          candidateId: item.candidate_id,
          evidenceIds: item.evidence_ids,
          createdAt: (item.created_at as Date).toISOString(),
          resolvedAt: item.resolved_at
            ? (item.resolved_at as Date).toISOString()
            : null,
        })),
      },
    });
  });

  app.get("/api/v1/obligations/:id/conflicts", async (request, reply) => {
    const session = await readSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    if (!uuid.test(id))
      return reply
        .code(400)
        .send(error(request, "invalid_id", "Identifier is invalid"));
    const owner = await pool.query(
      "SELECT 1 FROM obligations WHERE id=$1 AND user_id=$2",
      [id, session.userId],
    );
    if (!owner.rowCount)
      return reply
        .code(404)
        .send(error(request, "not_found", "Obligation not found"));
    const conflicts = await pool.query<Row>(
      `SELECT id,reason,state,proposal,candidate_id,created_at,resolved_at
       FROM obligation_conflicts WHERE obligation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC`,
      [id, session.userId],
    );
    return reply.send({
      data: conflicts.rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        state: row.state,
        proposal: row.proposal,
        candidateId: row.candidate_id,
        createdAt: (row.created_at as Date).toISOString(),
        resolvedAt: row.resolved_at
          ? (row.resolved_at as Date).toISOString()
          : null,
      })),
    });
  });

  const mutation = (
    action: "confirm" | "correct" | "pay" | "discard" | "resolve",
  ) => {
    app.post(`/api/v1/obligations/:id/${action}`, async (request, reply) => {
      if (!isTrustedOrigin(request, auth.appOrigin))
        return reply
          .code(403)
          .send(error(request, "origin_rejected", "Origin is not allowed"));
      if (
        request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
        "application/json"
      )
        return reply
          .code(415)
          .send(error(request, "invalid_content_type", "JSON is required"));
      const session = await readSession(request, reply);
      if (!session) return;
      if (!verifySessionCsrf(request, session.csrfTokenHash))
        return reply
          .code(403)
          .send(error(request, "csrf_rejected", "CSRF token is invalid"));
      const { id } = request.params as { id: string };
      if (!uuid.test(id))
        return reply
          .code(400)
          .send(error(request, "invalid_id", "Identifier is invalid"));
      const body = request.body as Row | null;
      if (
        !body ||
        !Number.isInteger(body.expectedVersion) ||
        Number(body.expectedVersion) < 1
      )
        return reply
          .code(400)
          .send(
            error(request, "invalid_request", "expectedVersion is required"),
          );
      let changes: Partial<Fields> | undefined;
      let conflictId: string | undefined;
      let resolution: "accept" | "reject" | undefined;
      if (action === "correct") {
        const raw = body.changes;
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length === 0 ||
          Object.keys(raw).some(
            (key) => !["title", "amount", "due"].includes(key),
          )
        )
          return reply
            .code(400)
            .send(error(request, "invalid_request", "Changes are invalid"));
        const value = raw as Row;
        if (
          (value.title !== undefined &&
            (typeof value.title !== "string" ||
              value.title.length < 1 ||
              value.title.length > 500)) ||
          (value.amount !== undefined &&
            !MoneySchema.safeParse(value.amount).success) ||
          (value.due !== undefined &&
            !DueValueSchema.safeParse(value.due).success)
        )
          return reply
            .code(400)
            .send(error(request, "invalid_request", "Changes are invalid"));
        changes = value as Partial<Fields>;
      } else if (action === "resolve") {
        if (
          typeof body.conflictId !== "string" ||
          !uuid.test(body.conflictId) ||
          (body.resolution !== "accept" && body.resolution !== "reject")
        )
          return reply
            .code(400)
            .send(
              error(
                request,
                "invalid_request",
                "Conflict and resolution are required",
              ),
            );
        conflictId = body.conflictId;
        resolution = body.resolution;
      } else if (Object.keys(body).some((key) => key !== "expectedVersion")) {
        return reply
          .code(400)
          .send(error(request, "invalid_request", "Unexpected field"));
      }
      try {
        const result = await service.mutate({
          userId: session.userId,
          sessionId: session.id,
          obligationId: id,
          expectedVersion: Number(body.expectedVersion),
          action,
          changes,
          conflictId,
          resolution,
        });
        return reply.send({
          data: {
            id,
            state: result.state,
            currentVersionId: result.versionId,
            revision: result.revision,
          },
        });
      } catch (caught) {
        if (caught instanceof ReconciliationError) {
          const status =
            caught.code === "not_found" || caught.code === "conflict_not_found"
              ? 404
              : 409;
          return reply
            .code(status)
            .send(error(request, caught.code, caught.message));
        }
        throw caught;
      }
    });
  };
  for (const action of [
    "confirm",
    "correct",
    "pay",
    "discard",
    "resolve",
  ] as const)
    mutation(action);

  const findEvidence = async (
    request: FastifyRequest,
    reply: { code: (status: number) => { send: (data: unknown) => unknown } },
  ) => {
    const session = await readSession(request, reply);
    if (!session) return null;
    const { id } = request.params as { id: string };
    if (!uuid.test(id)) {
      reply
        .code(400)
        .send(error(request, "invalid_id", "Identifier is invalid"));
      return null;
    }
    const result = await pool.query<Row>(
      `SELECT e.*,b.body_blob_id,a.blob_id AS attachment_blob_id
       FROM evidence e LEFT JOIN source_revision_bodies b ON b.source_item_revision_id=e.source_item_revision_id AND b.user_id=e.user_id
       LEFT JOIN source_attachments a ON a.id=e.attachment_id AND a.user_id=e.user_id
       WHERE e.id=$1 AND e.user_id=$2`,
      [id, session.userId],
    );
    if (!result.rows[0]) {
      reply.code(404).send(error(request, "not_found", "Evidence not found"));
      return null;
    }
    return { row: result.rows[0], userId: session.userId };
  };
  app.get("/api/v1/evidence/:id", async (request, reply) => {
    const found = await findEvidence(request, reply);
    if (!found) return;
    const e = found.row;
    return reply.send({
      data: {
        id: e.id,
        kind: e.kind,
        sourceItemRevisionId: e.source_item_revision_id,
        attachmentId: e.attachment_id,
        page: e.page,
        startOffset: e.start_offset,
        endOffset: e.end_offset,
        quote: e.quote,
        contentSha256: e.content_sha256,
        textUrl: `/api/v1/evidence/${e.id}/text`,
        sourceUrl: `/api/v1/evidence/${e.id}/source`,
      },
    });
  });
  app.get("/api/v1/evidence/:id/text", async (request, reply) => {
    const found = await findEvidence(request, reply);
    if (!found) return;
    const e = found.row;
    if (e.kind === "pdf_text_fragment") {
      const page = await pool.query<Row>(
        `SELECT extracted_text,content_sha256 FROM extraction_pdf_pages
         WHERE attachment_id=$1 AND user_id=$2 AND page=$3`,
        [e.attachment_id, found.userId, e.page],
      );
      if (!page.rows[0])
        return reply
          .code(404)
          .send(error(request, "not_found", "Page text not found"));
      return reply.send({
        data: {
          text: page.rows[0].extracted_text,
          contentSha256: page.rows[0].content_sha256,
          page: e.page,
        },
      });
    }
    if (!blobs || !e.body_blob_id)
      return reply
        .code(503)
        .send(
          error(
            request,
            "storage_unavailable",
            "Evidence storage is unavailable",
          ),
        );
    const bytes = await blobs.read(found.userId, str(e.body_blob_id));
    if (!bytes)
      return reply
        .code(404)
        .send(error(request, "not_found", "Source text not found"));
    return reply.send({
      data: {
        text: Buffer.from(bytes).toString("utf8"),
        contentSha256: e.content_sha256,
        page: null,
      },
    });
  });
  app.get("/api/v1/evidence/:id/source", async (request, reply) => {
    const found = await findEvidence(request, reply);
    if (!found) return;
    if (!blobs)
      return reply
        .code(503)
        .send(
          error(
            request,
            "storage_unavailable",
            "Evidence storage is unavailable",
          ),
        );
    const blobId =
      found.row.kind === "pdf_text_fragment"
        ? found.row.attachment_blob_id
        : found.row.body_blob_id;
    if (!blobId)
      return reply
        .code(404)
        .send(error(request, "not_found", "Source not found"));
    const bytes = await blobs.read(found.userId, str(blobId));
    if (!bytes)
      return reply
        .code(404)
        .send(error(request, "not_found", "Source not found"));
    reply.header(
      "Content-Type",
      found.row.kind === "pdf_text_fragment"
        ? "application/pdf"
        : "text/plain; charset=utf-8",
    );
    reply.header("Content-Disposition", "attachment");
    return reply.send(Buffer.from(bytes));
  });
}
