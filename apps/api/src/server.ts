import { buildApp } from "./app.ts";
import { SourceRepository, createPool } from "@crashmemory/db";
import { createGooglePubSubTokenVerifier } from "./gmail.ts";
import { TelegramLinkService } from "@crashmemory/notifications";
import { S3ObjectStorage } from "@crashmemory/runtime";
import type { FastifyServerOptions } from "fastify";
import {
  CredentialCipher,
  FASTIFY_REDACT_PATHS,
  OAuthStateSigner,
  safeErrorSerializer,
  safeRequestSerializer,
} from "@crashmemory/security";

const port = Number(process.env.API_PORT ?? 4310);
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
const cipher =
  pool &&
  process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON &&
  process.env.CREDENTIAL_ACTIVE_KEY_VERSION
    ? CredentialCipher.fromEnvironment(
        process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON,
        process.env.CREDENTIAL_ACTIVE_KEY_VERSION,
      )
    : undefined;
const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: [...FASTIFY_REDACT_PATHS], censor: "[REDACTED]" },
  serializers: {
    req: safeRequestSerializer,
    err: safeErrorSerializer,
  },
} as unknown as Exclude<FastifyServerOptions["logger"], boolean>;
const gmailConfigured = Boolean(
  process.env.GMAIL_CLIENT_ID &&
  process.env.GMAIL_CLIENT_SECRET &&
  process.env.GMAIL_REDIRECT_URI &&
  process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON &&
  process.env.CREDENTIAL_ACTIVE_KEY_VERSION &&
  process.env.OAUTH_STATE_SECRET_BASE64,
);
const app = buildApp({
  pool,
  ...(pool &&
  process.env.OBJECT_STORAGE_ENDPOINT &&
  process.env.OBJECT_STORAGE_ACCESS_KEY &&
  process.env.OBJECT_STORAGE_SECRET_KEY
    ? {
        objectStorage: new S3ObjectStorage({
          endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
          bucket: process.env.OBJECT_STORAGE_BUCKET ?? "crashmemory",
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
        }),
      }
    : {}),
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
  ...(pool && gmailConfigured
    ? {
        gmail: {
          clientId: process.env.GMAIL_CLIENT_ID!,
          clientSecret: process.env.GMAIL_CLIENT_SECRET!,
          redirectUri: process.env.GMAIL_REDIRECT_URI!,
          stateSigner: new OAuthStateSigner(
            Buffer.from(process.env.OAUTH_STATE_SECRET_BASE64!, "base64"),
          ),
          credentialCipher: CredentialCipher.fromEnvironment(
            process.env.CREDENTIAL_ENCRYPTION_KEYS_JSON,
            process.env.CREDENTIAL_ACTIVE_KEY_VERSION,
          ),
          ...(process.env.GOOGLE_PUBSUB_AUDIENCE &&
          process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL
            ? {
                verifyPushToken: createGooglePubSubTokenVerifier(
                  process.env.GOOGLE_PUBSUB_AUDIENCE,
                  process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
                ),
                onPushNotification: async (notification: {
                  emailAddress: string;
                  historyId: string;
                }) => {
                  await new SourceRepository(pool!).recordGmailPushNotification(
                    notification.emailAddress
                      .normalize("NFKC")
                      .trim()
                      .toLowerCase(),
                    notification.historyId,
                  );
                },
              }
            : {}),
        },
      }
    : {}),
  ...(pool && cipher && process.env.TELEGRAM_BOT_TOKEN
    ? { telegramLinks: new TelegramLinkService(pool, cipher) }
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
