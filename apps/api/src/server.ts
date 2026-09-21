import { buildApp } from "./app.ts";
import { createPool } from "@crashmemory/db";
import type { FastifyServerOptions } from "fastify";
import {
  FASTIFY_REDACT_PATHS,
  safeErrorSerializer,
  safeRequestSerializer,
} from "@crashmemory/security";

const port = Number(process.env.API_PORT ?? 4310);
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: [...FASTIFY_REDACT_PATHS], censor: "[REDACTED]" },
  serializers: {
    req: safeRequestSerializer,
    err: safeErrorSerializer,
  },
} as unknown as Exclude<FastifyServerOptions["logger"], boolean>;
const app = buildApp({
  pool,
  ...(pool
    ? {
        auth: {
          appOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
          cookieName:
            process.env.APP_SESSION_COOKIE_NAME ?? "crashmemory_session",
          cookieSecure: process.env.APP_SESSION_COOKIE_SECURE !== "false",
          sessionTtlSeconds: Number(
            process.env.APP_SESSION_TTL_SECONDS ?? 43_200,
          ),
        },
      }
    : {}),
  logger: loggerOptions,
});

if (pool) app.addHook("onClose", async () => pool.end());

try {
  await app.listen({ host: "127.0.0.1", port });
  console.log(
    `CrashMemory synthetic demo API listening on http://127.0.0.1:${port}`,
  );
} catch (error) {
  app.log.error({ err: error }, "server startup failed");
  process.exitCode = 1;
}
