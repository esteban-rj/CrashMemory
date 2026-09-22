import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { NotificationRepository } from "@crashmemory/db";
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

type Cursor =
  { scheduledFor: string; id: string } | { preparedAt: string; id: string };
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cursorTime =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function validCursorTime(value: string): boolean {
  const parts = cursorTime.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, zone] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number(year) < 1 ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return false;
  if (zone === "Z") return true;
  const offset = zone!.slice(1).replace(":", "");
  return Number(offset.slice(0, 2)) <= 15 && Number(offset.slice(2) || 0) <= 59;
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 25;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : null;
}

function parseCursor(
  value: unknown,
  kind: "reminders" | "attempts",
): Cursor | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const timestamp =
      kind === "reminders" ? decoded.scheduledFor : decoded.preparedAt;
    if (
      typeof timestamp !== "string" ||
      typeof decoded.id !== "string" ||
      !uuid.test(decoded.id) ||
      !validCursorTime(timestamp)
    )
      return null;
    return kind === "reminders"
      ? { scheduledFor: timestamp, id: decoded.id }
      : { preparedAt: timestamp, id: decoded.id };
  } catch {
    return null;
  }
}

function nextCursor(item: Cursor | undefined): string | undefined {
  return item
    ? Buffer.from(JSON.stringify(item), "utf8").toString("base64url")
    : undefined;
}

async function sessionForRead(
  request: FastifyRequest,
  pool: Pool,
  auth: AuthConfig,
) {
  return resolveSession(request, pool, auth);
}

export function registerTelegramRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: AuthConfig,
  links?: TelegramLinkService,
): void {
  app.get("/api/v1/telegram/status", async (request, reply) => {
    const session = await sessionForRead(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          error(request, "unauthenticated", "An active session is required"),
        );
    const status = await new NotificationRepository(pool).linkStatus(
      session.userId,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ data: status });
  });

  app.get("/api/v1/reminders", async (request, reply) => {
    const session = await sessionForRead(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          error(request, "unauthenticated", "An active session is required"),
        );
    const query = request.query as { limit?: unknown; cursor?: unknown };
    const limit = parseLimit(query.limit);
    const cursor = parseCursor(query.cursor, "reminders");
    if (limit === null || cursor === null)
      return reply
        .code(400)
        .send(error(request, "invalid_pagination", "Pagination is invalid"));
    const items = await new NotificationRepository(pool).listReminders({
      userId: session.userId,
      limit: limit + 1,
      cursor: cursor as { scheduledFor: string; id: string } | undefined,
    });
    const page = items.slice(0, limit);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      data: page,
      meta: {
        nextCursor:
          items.length > limit
            ? nextCursor(
                page.at(-1)
                  ? {
                      scheduledFor: page.at(-1)!.scheduledFor,
                      id: page.at(-1)!.id,
                    }
                  : undefined,
              )
            : undefined,
      },
    });
  });

  app.get("/api/v1/reminders/:reminderId/attempts", async (request, reply) => {
    const session = await sessionForRead(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          error(request, "unauthenticated", "An active session is required"),
        );
    const params = request.params as { reminderId?: unknown };
    if (typeof params.reminderId !== "string" || !uuid.test(params.reminderId))
      return reply
        .code(400)
        .send(
          error(request, "invalid_request", "Reminder identifier is required"),
        );
    const query = request.query as { limit?: unknown; cursor?: unknown };
    const limit = parseLimit(query.limit);
    const cursor = parseCursor(query.cursor, "attempts");
    if (limit === null || cursor === null)
      return reply
        .code(400)
        .send(error(request, "invalid_pagination", "Pagination is invalid"));
    const items = await new NotificationRepository(pool).listDeliveryAttempts({
      userId: session.userId,
      reminderId: params.reminderId,
      limit: limit + 1,
      cursor: cursor as { preparedAt: string; id: string } | undefined,
    });
    const page = items.slice(0, limit);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      data: page,
      meta: {
        nextCursor:
          items.length > limit
            ? nextCursor(
                page.at(-1)
                  ? { preparedAt: page.at(-1)!.preparedAt, id: page.at(-1)!.id }
                  : undefined,
              )
            : undefined,
      },
    });
  });

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
    if (!links)
      return reply
        .code(503)
        .send(
          error(
            request,
            "telegram_unavailable",
            "Telegram linking is not configured",
          ),
        );
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
