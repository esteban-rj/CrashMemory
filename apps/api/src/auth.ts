import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  LedgerRepository,
  SessionRepository,
  UserRepository,
  inTransaction,
} from "@crashmemory/db";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  normalizeEmail,
  safeTokenEqual,
  verifyPassword,
} from "@crashmemory/security";

export interface AuthConfig {
  appOrigin: string;
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
}

function requestError(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    try {
      cookies.set(
        part.slice(0, separator).trim(),
        decodeURIComponent(part.slice(separator + 1).trim()),
      );
    } catch {
      // An invalid cookie is treated as absent.
    }
  }
  return cookies;
}

export async function resolveSession(
  request: FastifyRequest,
  pool: Pool,
  config: Pick<AuthConfig, "cookieName">,
) {
  const token = parseCookies(request.headers.cookie).get(config.cookieName);
  if (!token) return null;
  return new SessionRepository(pool).findActive(hashOpaqueToken(token));
}

export function verifySessionCsrf(
  request: FastifyRequest,
  csrfTokenHash: string,
): boolean {
  const csrf = request.headers["x-csrf-token"];
  return typeof csrf === "string" && safeTokenEqual(csrf, csrfTokenHash);
}

function isTrustedOrigin(request: FastifyRequest, appOrigin: string): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === appOrigin;
}

function hasJsonContentType(request: FastifyRequest): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

function sessionCookie(
  config: AuthConfig,
  token: string,
  maxAge: number,
): string {
  return [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    config.cookieSecure ? "Secure" : "",
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AuthConfig,
): void {
  app.post("/api/v1/auth/login", async (request, reply) => {
    if (!isTrustedOrigin(request, config.appOrigin)) {
      return reply
        .code(403)
        .send(
          requestError(
            request,
            "origin_rejected",
            "Request origin is not allowed",
          ),
        );
    }
    if (!hasJsonContentType(request)) {
      return reply
        .code(415)
        .send(
          requestError(
            request,
            "invalid_content_type",
            "Content-Type must be application/json",
          ),
        );
    }
    const body = request.body as { email?: unknown; password?: unknown } | null;
    if (
      !body ||
      typeof body.email !== "string" ||
      typeof body.password !== "string"
    ) {
      return reply
        .code(400)
        .send(
          requestError(
            request,
            "invalid_request",
            "Email and password are required",
          ),
        );
    }

    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(body.email);
    } catch {
      return reply
        .code(401)
        .send(
          requestError(request, "invalid_credentials", "Invalid credentials"),
        );
    }
    const user = await new UserRepository(pool).findByEmail(normalizedEmail);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply
        .code(401)
        .send(
          requestError(request, "invalid_credentials", "Invalid credentials"),
        );
    }

    const token = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    await inTransaction(pool, async (client) => {
      await new SessionRepository(client).create({
        id: sessionId,
        userId: user.id,
        tokenHash: hashOpaqueToken(token),
        csrfTokenHash: hashOpaqueToken(csrfToken),
        expiresAt,
      });
      await new LedgerRepository(client).appendAudit({
        id: randomUUID(),
        userId: user.id,
        actorSessionId: sessionId,
        action: "auth.login",
        targetType: "auth_session",
        targetId: sessionId,
      });
    });
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Set-Cookie",
      sessionCookie(config, token, config.sessionTtlSeconds),
    );
    return reply.send({
      data: {
        user: {
          id: user.id,
          email: user.emailNormalized,
          timeZone: user.timeZone,
        },
        csrfToken,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!isTrustedOrigin(request, config.appOrigin)) {
      return reply
        .code(403)
        .send(
          requestError(
            request,
            "origin_rejected",
            "Request origin is not allowed",
          ),
        );
    }
    if (!hasJsonContentType(request)) {
      return reply
        .code(415)
        .send(
          requestError(
            request,
            "invalid_content_type",
            "Content-Type must be application/json",
          ),
        );
    }
    const session = await resolveSession(request, pool, config);
    if (!session) {
      return reply
        .code(401)
        .send(
          requestError(
            request,
            "authentication_required",
            "Authentication required",
          ),
        );
    }
    if (!verifySessionCsrf(request, session.csrfTokenHash)) {
      return reply
        .code(403)
        .send(requestError(request, "csrf_rejected", "CSRF token is invalid"));
    }
    await inTransaction(pool, async (client) => {
      await new LedgerRepository(client).appendAudit({
        id: randomUUID(),
        userId: session.userId,
        actorSessionId: session.id,
        action: "auth.logout",
        targetType: "auth_session",
        targetId: session.id,
      });
      await new SessionRepository(client).revoke(session.id, session.userId);
    });
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", sessionCookie(config, "", 0));
    return reply.send({ data: { loggedOut: true } });
  });
}
