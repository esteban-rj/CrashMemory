import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { TelegramLinkService } from "@crashmemory/notifications";
import { resolveSession, verifySessionCsrf, type AuthConfig } from "./auth.ts";

function error(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

function trusted(request: FastifyRequest, appOrigin: string): boolean {
  return (
    request.headers.origin === undefined || request.headers.origin === appOrigin
  );
}

export function registerTelegramRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: AuthConfig,
  links: TelegramLinkService,
): void {
  app.post("/api/v1/telegram/link", async (request, reply) => {
    if (!trusted(request, auth.appOrigin)) {
      return reply
        .code(403)
        .send(
          error(request, "origin_rejected", "Request origin is not allowed"),
        );
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      return reply
        .code(415)
        .send(
          error(
            request,
            "invalid_content_type",
            "Content-Type must be application/json",
          ),
        );
    }
    const session = await resolveSession(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          error(request, "unauthenticated", "An active session is required"),
        );
    if (!verifySessionCsrf(request, session.csrfTokenHash)) {
      return reply
        .code(403)
        .send(error(request, "csrf_rejected", "CSRF token is required"));
    }
    const challenge = await links.start(session.userId);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      data: {
        // Displayed once to the authenticated user.  Persistence contains only
        // its hash, so a database reader cannot activate a bot link.
        startCommand: `/start ${challenge.token}`,
        expiresAt: challenge.expiresAt.toISOString(),
      },
    });
  });
}
