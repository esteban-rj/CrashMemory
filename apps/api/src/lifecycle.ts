import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  LifecycleNotFoundError,
  LifecycleJournalRequiredError,
  LifecycleService,
  LifecycleStorageRequiredError,
} from "@crashmemory/lifecycle";
import type { ObjectStorage } from "@crashmemory/runtime";
import type { GmailRouteConfig } from "./gmail.ts";
import {
  isTrustedOrigin,
  resolveSession,
  verifySessionCsrf,
  type AuthConfig,
} from "./auth.ts";

function error(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

function isJson(request: FastifyRequest): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

async function mutationSession(
  request: FastifyRequest,
  pool: Pool,
  auth: AuthConfig,
) {
  if (!isTrustedOrigin(request, auth.appOrigin))
    return {
      failure: [
        403,
        "origin_rejected",
        "Request origin is not allowed",
      ] as const,
    };
  if (!isJson(request))
    return {
      failure: [
        415,
        "invalid_content_type",
        "Content-Type must be application/json",
      ] as const,
    };
  const session = await resolveSession(request, pool, auth);
  if (!session)
    return {
      failure: [
        401,
        "authentication_required",
        "Authentication required",
      ] as const,
    };
  if (!verifySessionCsrf(request, session.csrfTokenHash))
    return {
      failure: [403, "csrf_rejected", "CSRF token is required"] as const,
    };
  return { session };
}

function sendFailure(
  request: FastifyRequest,
  reply: { code(status: number): { send(body: unknown): unknown } },
  cause: unknown,
) {
  if (cause instanceof LifecycleNotFoundError)
    return reply
      .code(404)
      .send(error(request, "not_found", "Lifecycle target was not found"));
  if (cause instanceof LifecycleStorageRequiredError)
    return reply
      .code(503)
      .send(
        error(
          request,
          "object_storage_unavailable",
          "Object storage is required for this operation",
        ),
      );
  if (cause instanceof LifecycleJournalRequiredError)
    return reply
      .code(503)
      .send(
        error(
          request,
          "lifecycle_journal_unavailable",
          "Lifecycle journal is required for this operation",
        ),
      );
  throw cause;
}

export function registerLifecycleRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: AuthConfig,
  objectStorage?: ObjectStorage,
  journal?: import("@crashmemory/lifecycle").DeletionJournal,
  gmail?: GmailRouteConfig,
): void {
  const lifecycle = new LifecycleService(
    pool,
    objectStorage,
    journal,
    gmail
      ? {
          async revoke(input) {
            let refreshToken: string | undefined;
            try {
              const parsed = JSON.parse(
                gmail.credentialCipher.decrypt(
                  input.encrypted,
                  `${input.userId}:${input.connectionId}`,
                ),
              ) as { refreshToken?: unknown };
              if (typeof parsed.refreshToken === "string")
                refreshToken = parsed.refreshToken;
            } catch {
              return "failed" as const;
            }
            if (!refreshToken) return "failed" as const;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10_000);
            try {
              const response = await fetch(
                "https://oauth2.googleapis.com/revoke",
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({ token: refreshToken }),
                  signal: controller.signal,
                },
              );
              return response.ok ? ("revoked" as const) : ("failed" as const);
            } catch {
              return "failed" as const;
            } finally {
              clearTimeout(timer);
            }
          },
        }
      : undefined,
  );
  app.post("/api/v1/lifecycle/gmail/disconnect", async (request, reply) => {
    const access = await mutationSession(request, pool, auth);
    if ("failure" in access) {
      const failure = access.failure!;
      return reply
        .code(failure[0])
        .send(error(request, failure[1], failure[2]));
    }
    const body = request.body as { connectionId?: unknown } | null;
    if (!body || typeof body.connectionId !== "string")
      return reply
        .code(400)
        .send(error(request, "invalid_request", "connectionId is required"));
    try {
      const remoteRevocation = await lifecycle.disconnectGmail({
        userId: access.session.userId,
        connectionId: body.connectionId,
        actorSessionId: access.session.id,
      });
      return reply.send({
        data: { state: "disconnected", remoteRevocation },
      });
    } catch (cause) {
      return sendFailure(request, reply, cause);
    }
  });
  app.post("/api/v1/lifecycle/telegram/unlink", async (request, reply) => {
    const access = await mutationSession(request, pool, auth);
    if ("failure" in access) {
      const failure = access.failure!;
      return reply
        .code(failure[0])
        .send(error(request, failure[1], failure[2]));
    }
    try {
      const cancelledReminders = await lifecycle.unlinkTelegram({
        userId: access.session.userId,
        actorSessionId: access.session.id,
      });
      return reply.send({ data: { state: "unlinked", cancelledReminders } });
    } catch (cause) {
      return sendFailure(request, reply, cause);
    }
  });
  app.delete(
    "/api/v1/lifecycle/sources/:connectionId",
    async (request, reply) => {
      const access = await mutationSession(request, pool, auth);
      if ("failure" in access) {
        const failure = access.failure!;
        return reply
          .code(failure[0])
          .send(error(request, failure[1], failure[2]));
      }
      const { connectionId } = request.params as { connectionId?: string };
      if (!connectionId)
        return reply
          .code(400)
          .send(error(request, "invalid_request", "connectionId is required"));
      try {
        return reply.send({
          data: await lifecycle.deleteSourceConnection({
            userId: access.session.userId,
            connectionId,
            actorSessionId: access.session.id,
          }),
        });
      } catch (cause) {
        return sendFailure(request, reply, cause);
      }
    },
  );
  app.delete(
    "/api/v1/lifecycle/sources/:connectionId/items/:externalMessageId",
    async (request, reply) => {
      const access = await mutationSession(request, pool, auth);
      if ("failure" in access) {
        const failure = access.failure!;
        return reply
          .code(failure[0])
          .send(error(request, failure[1], failure[2]));
      }
      const { connectionId, externalMessageId } = request.params as {
        connectionId?: string;
        externalMessageId?: string;
      };
      if (!connectionId || !externalMessageId)
        return reply
          .code(400)
          .send(
            error(
              request,
              "invalid_request",
              "Source item identifiers are required",
            ),
          );
      try {
        return reply.send({
          data: await lifecycle.deleteSourceItem({
            userId: access.session.userId,
            connectionId,
            externalMessageId,
            actorSessionId: access.session.id,
          }),
        });
      } catch (cause) {
        return sendFailure(request, reply, cause);
      }
    },
  );
  app.get("/api/v1/lifecycle/export", async (request, reply) => {
    const session = await resolveSession(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          error(request, "authentication_required", "Authentication required"),
        );
    const includeOriginals =
      (request.query as { includeOriginals?: unknown }).includeOriginals ===
      "true";
    try {
      return reply.send({
        data: await lifecycle.exportUser(session.userId, includeOriginals),
      });
    } catch (cause) {
      return sendFailure(request, reply, cause);
    }
  });
  app.delete(
    "/api/v1/lifecycle/obligations/:obligationId",
    async (request, reply) => {
      const access = await mutationSession(request, pool, auth);
      if ("failure" in access) {
        const failure = access.failure!;
        return reply
          .code(failure[0])
          .send(error(request, failure[1], failure[2]));
      }
      const { obligationId } = request.params as { obligationId?: string };
      if (!obligationId)
        return reply
          .code(400)
          .send(error(request, "invalid_request", "obligationId is required"));
      try {
        await lifecycle.deleteObligation({
          userId: access.session.userId,
          obligationId,
          actorSessionId: access.session.id,
        });
        return reply.send({ data: { state: "deleted" } });
      } catch (cause) {
        return sendFailure(request, reply, cause);
      }
    },
  );
  app.delete("/api/v1/lifecycle/account", async (request, reply) => {
    const access = await mutationSession(request, pool, auth);
    if ("failure" in access) {
      const failure = access.failure!;
      return reply
        .code(failure[0])
        .send(error(request, failure[1], failure[2]));
    }
    try {
      return reply.send({
        data: {
          state: "deleted",
          ...(await lifecycle.deleteAccount({ userId: access.session.userId })),
        },
      });
    } catch (cause) {
      return sendFailure(request, reply, cause);
    }
  });
}
