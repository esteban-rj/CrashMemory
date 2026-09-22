import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  LedgerRepository,
  OAuthCallbackRepository,
  SourceRepository,
  inTransaction,
} from "@crashmemory/db";
import {
  CredentialCipher,
  OAuthStateSigner,
  generateOpaqueToken,
  hashOpaqueToken,
} from "@crashmemory/security";
import { GMAIL_READONLY_SCOPE } from "@crashmemory/gmail";
import { resolveSession, type AuthConfig, verifySessionCsrf } from "./auth.ts";

export interface GmailRouteConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSigner: OAuthStateSigner;
  credentialCipher: CredentialCipher;
  /** Verifies the Google-signed OIDC token on Pub/Sub push requests. */
  verifyPushToken?: (authorization: string | undefined) => Promise<boolean>;
  /** Schedules a connection-scoped catch-up; it never trusts the Pub/Sub body as data. */
  onPushNotification?: (input: {
    emailAddress: string;
    historyId: string;
  }) => Promise<void>;
}

export function createGooglePubSubTokenVerifier(
  audience: string,
  serviceAccountEmail: string,
) {
  return async (authorization: string | undefined): Promise<boolean> => {
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization ?? "");
    if (!match) return false;
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(match[1]!)}`,
    );
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const issuer = payload?.iss;
    const expiresAt =
      typeof payload?.exp === "string" ? Number(payload.exp) : NaN;
    return Boolean(
      response.ok &&
      payload?.aud === audience &&
      payload?.email === serviceAccountEmail &&
      (payload?.email_verified === "true" ||
        payload?.email_verified === true) &&
      (issuer === "accounts.google.com" ||
        issuer === "https://accounts.google.com") &&
      Number.isFinite(expiresAt) &&
      expiresAt * 1000 > Date.now(),
    );
  };
}

function requestError(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

function trustedOrigin(request: FastifyRequest, appOrigin: string): boolean {
  return (
    request.headers.origin === undefined || request.headers.origin === appOrigin
  );
}

function isJson(request: FastifyRequest): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

function googleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    // Reconnection must obtain a replacement refresh token; Google can omit it
    // when it reuses a prior grant without an explicit consent prompt.
    prompt: "consent",
    state: input.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

async function exchangeCode(
  config: GmailRouteConfig,
  code: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !response.ok ||
    !payload ||
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string"
  ) {
    throw new Error(
      "Google OAuth token exchange did not provide a refresh token",
    );
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function googleProfile(
  accessToken: string,
): Promise<{ emailAddress: string }> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !payload || typeof payload.emailAddress !== "string") {
    throw new Error("Google Gmail profile could not be read");
  }
  return {
    emailAddress: payload.emailAddress.normalize("NFKC").trim().toLowerCase(),
  };
}

function parsePushPayload(
  value: unknown,
): { emailAddress: string; historyId: string } | null {
  if (!value || typeof value !== "object" || !("message" in value)) return null;
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !("data" in message))
    return null;
  const data = (message as { data?: unknown }).data;
  if (typeof data !== "string") return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof decoded.emailAddress !== "string" ||
      typeof decoded.historyId !== "string"
    )
      return null;
    return { emailAddress: decoded.emailAddress, historyId: decoded.historyId };
  } catch {
    return null;
  }
}

export function registerGmailRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: AuthConfig,
  config?: GmailRouteConfig,
): void {
  app.post("/api/v1/gmail/connect", async (request, reply) => {
    if (!config)
      return reply
        .code(503)
        .send(
          requestError(
            request,
            "gmail_unconfigured",
            "Gmail OAuth is not configured",
          ),
        );
    if (!trustedOrigin(request, auth.appOrigin))
      return reply
        .code(403)
        .send(
          requestError(
            request,
            "origin_rejected",
            "Request origin is not allowed",
          ),
        );
    if (!isJson(request))
      return reply
        .code(415)
        .send(
          requestError(
            request,
            "invalid_content_type",
            "Content-Type must be application/json",
          ),
        );
    const session = await resolveSession(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          requestError(
            request,
            "authentication_required",
            "Authentication required",
          ),
        );
    if (!verifySessionCsrf(request, session.csrfTokenHash))
      return reply
        .code(403)
        .send(requestError(request, "csrf_rejected", "CSRF token is invalid"));
    const body = request.body as { redirectPath?: unknown } | null;
    const redirectPath =
      typeof body?.redirectPath === "string" ? body.redirectPath : "/gmail";
    const nonce = generateOpaqueToken();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const state = config.stateSigner.issue({
      userId: session.userId,
      sessionId: session.id,
      provider: "gmail",
      redirectPath,
      nonce,
      expiresAt,
    });
    await new OAuthCallbackRepository(pool).create({
      id: randomUUID(),
      userId: session.userId,
      authSessionId: session.id,
      provider: "gmail",
      nonceHash: hashOpaqueToken(nonce),
      expiresAt: new Date(expiresAt),
    });
    reply.header("Cache-Control", "no-store");
    return reply.send({
      data: {
        authorizationUrl: googleAuthorizationUrl({
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          state,
        }),
      },
    });
  });

  app.get("/api/v1/gmail/callback", async (request, reply) => {
    if (!config)
      return reply
        .code(503)
        .send(
          requestError(
            request,
            "gmail_unconfigured",
            "Gmail OAuth is not configured",
          ),
        );
    const query = request.query as { code?: unknown; state?: unknown };
    if (typeof query.code !== "string" || typeof query.state !== "string")
      return reply
        .code(400)
        .send(
          requestError(
            request,
            "invalid_request",
            "OAuth callback is incomplete",
          ),
        );
    let state: ReturnType<OAuthStateSigner["verify"]>;
    try {
      state = config.stateSigner.verify(query.state);
    } catch {
      return reply
        .code(400)
        .send(
          requestError(
            request,
            "oauth_state_rejected",
            "OAuth state is invalid or expired",
          ),
        );
    }
    // A signed state is only a browser correlation value. The callback still
    // requires the same currently-active app session that created that state.
    const session = await resolveSession(request, pool, auth);
    if (
      !session ||
      session.id !== state.sessionId ||
      session.userId !== state.userId
    ) {
      return reply
        .code(401)
        .send(
          requestError(
            request,
            "authentication_required",
            "OAuth session is no longer active",
          ),
        );
    }
    const lifecycleEpoch = await new OAuthCallbackRepository(pool).consume({
      userId: state.userId,
      authSessionId: state.sessionId,
      provider: "gmail",
      nonceHash: hashOpaqueToken(state.nonce),
    });
    if (lifecycleEpoch === null)
      return reply
        .code(400)
        .send(
          requestError(
            request,
            "oauth_state_rejected",
            "OAuth callback was already used or expired",
          ),
        );
    try {
      const token = await exchangeCode(config, query.code);
      const profile = await googleProfile(token.accessToken);
      await inTransaction(pool, async (client) => {
        const epoch = await client.query(
          "SELECT 1 FROM users WHERE id = $1 AND lifecycle_epoch = $2 FOR UPDATE",
          [state.userId, lifecycleEpoch],
        );
        if (epoch.rowCount !== 1) {
          throw new Error("OAuth consent was invalidated by lifecycle change");
        }
        const sources = new SourceRepository(client);
        let connection = await sources.findConnectionByExternalAccount(
          state.userId,
          profile.emailAddress,
        );
        if (!connection) {
          connection = { id: randomUUID(), state: "pending" };
          await sources.createConnection({
            id: connection.id,
            userId: state.userId,
            externalAccountId: profile.emailAddress,
          });
        }
        await sources.storeCredential({
          id: randomUUID(),
          userId: state.userId,
          sourceConnectionId: connection.id,
          encrypted: config.credentialCipher.encrypt(
            JSON.stringify({
              refreshToken: token.refreshToken,
              accessToken: token.accessToken,
              expiresAt: token.expiresAt,
            }),
            `${state.userId}:${connection.id}`,
          ),
        });
        await sources.markConnectionAuthorized(state.userId, connection.id);
        await new LedgerRepository(client).appendAudit({
          id: randomUUID(),
          userId: state.userId,
          actorSessionId: state.sessionId,
          action: "gmail.oauth.connected",
          targetType: "source_connection",
          targetId: connection.id,
        });
      });
    } catch {
      return reply
        .code(502)
        .send(
          requestError(
            request,
            "gmail_oauth_failed",
            "Gmail authorization could not be completed; reconnect Gmail",
          ),
        );
    }
    reply.header("Cache-Control", "no-store");
    return reply.redirect(state.redirectPath, 303);
  });

  app.get("/api/v1/gmail", async (request, reply) => {
    const session = await resolveSession(request, pool, auth);
    if (!session)
      return reply
        .code(401)
        .send(
          requestError(
            request,
            "authentication_required",
            "Authentication required",
          ),
        );
    const records = await new SourceRepository(pool).listConnections(
      session.userId,
    );
    return reply.send({
      data: records.map((record) => ({
        id: String(record.id),
        email: String(record.external_account_id),
        state: String(record.state),
        watchExpiresAt: record.watch_expiration_at
          ? (record.watch_expiration_at as Date).toISOString()
          : null,
        lastSyncAt: record.last_sync_at
          ? (record.last_sync_at as Date).toISOString()
          : null,
        errorCode: record.last_sync_error_code
          ? String(record.last_sync_error_code)
          : null,
      })),
    });
  });

  app.post("/webhooks/google/gmail", async (request, reply) => {
    if (!config?.verifyPushToken || !config.onPushNotification)
      return reply.code(503).send({ error: "gmail_webhook_unconfigured" });
    if (!(await config.verifyPushToken(request.headers.authorization)))
      return reply.code(401).send({ error: "unauthorized" });
    const notification = parsePushPayload(request.body);
    if (!notification)
      return reply.code(400).send({ error: "invalid_notification" });
    await config.onPushNotification(notification);
    return reply.code(204).send();
  });
}
