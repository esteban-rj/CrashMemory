import Fastify, { type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import { CONTRACT_VERSION, demoObligation } from "@crashmemory/contracts";
import { TelegramLinkService } from "@crashmemory/notifications";
import { registerAuthRoutes, type AuthConfig } from "./auth.ts";
import { registerGmailRoutes, type GmailRouteConfig } from "./gmail.ts";
import { registerTelegramRoutes } from "./telegram.ts";
import { registerObligationRoutes } from "./obligations.ts";
import { registerLifecycleRoutes } from "./lifecycle.ts";
import type { ObjectStorage } from "@crashmemory/runtime";
import type { DeletionJournal } from "@crashmemory/lifecycle";

export function buildApp(
  options: {
    pool?: Pool;
    auth?: AuthConfig;
    gmail?: GmailRouteConfig;
    telegramLinks?: TelegramLinkService;
    objectStorage?: ObjectStorage;
    lifecycleJournal?: DeletionJournal;
    logger?: FastifyServerOptions["logger"];
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const reportedStatus =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const statusCode =
      reportedStatus && reportedStatus >= 400 && reportedStatus < 500
        ? reportedStatus
        : 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "internal_error" : "invalid_request",
        message:
          statusCode === 500
            ? "The request could not be completed"
            : "The request is invalid",
        requestId: request.id,
      },
    });
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/v1/")) {
      reply.header("X-CrashMemory-Contract", CONTRACT_VERSION);
      reply.header("Cache-Control", "no-store");
    }
  });

  app.get("/healthz", async () => ({
    status: "ok",
    mode: process.env.APP_ENV ?? "demo",
  }));
  app.get("/api/v1/contracts", async () => ({ version: CONTRACT_VERSION }));
  app.get("/api/v1/demo/obligations", async () => ({
    data: [demoObligation],
    meta: { mode: "synthetic-demo", persistence: "none" },
  }));

  if (options.pool && options.auth) {
    registerAuthRoutes(app, options.pool, options.auth);
    registerObligationRoutes(
      app,
      options.pool,
      options.auth,
      options.objectStorage,
    );
    registerGmailRoutes(app, options.pool, options.auth, options.gmail);
    registerTelegramRoutes(
      app,
      options.pool,
      options.auth,
      options.telegramLinks,
    );
    registerLifecycleRoutes(
      app,
      options.pool,
      options.auth,
      options.objectStorage,
      options.lifecycleJournal,
    );
  } else {
    app.post("/api/v1/auth/login", async (request, reply) =>
      reply.code(503).send({
        error: {
          code: "persistence_unavailable",
          message: "Authentication requires PostgreSQL configuration",
          requestId: request.id,
        },
      }),
    );
    app.post("/api/v1/auth/logout", async (request, reply) =>
      reply.code(503).send({
        error: {
          code: "persistence_unavailable",
          message: "Authentication requires PostgreSQL configuration",
          requestId: request.id,
        },
      }),
    );
  }

  return app;
}
