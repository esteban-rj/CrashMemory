import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CredentialCipher,
  OAuthStateSigner,
  hashPassword,
} from "@crashmemory/security";
import {
  SourceRepository,
  UserRepository,
  createPool,
  migrate,
} from "@crashmemory/db";
import { buildApp } from "../src/app.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = "http://127.0.0.1:3004";

function config() {
  return {
    clientId: "synthetic-client-id",
    clientSecret: "synthetic-client-secret",
    redirectUri: "http://127.0.0.1:4314/api/v1/gmail/callback",
    stateSigner: new OAuthStateSigner(Buffer.alloc(32, 4)),
    credentialCipher: new CredentialCipher(
      "v1",
      new Map([["v1", Buffer.alloc(32, 8)]]),
    ),
  };
}

async function login(app: ReturnType<typeof buildApp>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin, "content-type": "application/json" },
    payload: { email, password: "synthetic-login-password" },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: String(response.headers["set-cookie"]).split(";", 1)[0]!,
    csrf: response.json().data.csrfToken as string,
  };
}

async function startConnect(
  app: ReturnType<typeof buildApp>,
  auth: { cookie: string; csrf: string },
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/gmail/connect",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
    },
    payload: { redirectPath: "/gmail" },
  });
  assert.equal(response.statusCode, 200);
  return new URL(response.json().data.authorizationUrl).searchParams.get(
    "state",
  )!;
}

test(
  "Gmail OAuth callback requires the original active app session",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userA = randomUUID();
    const userB = randomUUID();
    const emailA = `${userA}@example.test`;
    const emailB = `${userB}@example.test`;
    await new UserRepository(pool).create({
      id: userA,
      emailNormalized: emailA,
      passwordHash: await hashPassword("synthetic-login-password"),
      timeZone: "America/Bogota",
    });
    await new UserRepository(pool).create({
      id: userB,
      emailNormalized: emailB,
      passwordHash: await hashPassword("synthetic-login-password"),
      timeZone: "America/Bogota",
    });
    const notifications: Array<{ emailAddress: string; historyId: string }> =
      [];
    const app = buildApp({
      pool,
      auth: {
        appOrigin: origin,
        cookieName: "gmail_test_session",
        cookieSecure: false,
        sessionTtlSeconds: 3600,
      },
      gmail: {
        ...config(),
        async verifyPushToken(authorization) {
          return authorization === "Bearer synthetic-push-token";
        },
        async onPushNotification(notification) {
          notifications.push(notification);
        },
      },
    });
    await app.ready();
    try {
      const a = await login(app, emailA);
      const b = await login(app, emailB);

      const absentState = await startConnect(app, a);
      const absent = await app.inject({
        method: "GET",
        url: `/api/v1/gmail/callback?code=x&state=${encodeURIComponent(absentState)}`,
      });
      assert.equal(absent.statusCode, 401);

      const foreignState = await startConnect(app, a);
      const foreign = await app.inject({
        method: "GET",
        url: `/api/v1/gmail/callback?code=x&state=${encodeURIComponent(foreignState)}`,
        headers: { cookie: b.cookie },
      });
      assert.equal(foreign.statusCode, 401);

      const revokedState = await startConnect(app, a);
      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: a.cookie,
          "x-csrf-token": a.csrf,
        },
        payload: {},
      });
      assert.equal(logout.statusCode, 200);
      const revoked = await app.inject({
        method: "GET",
        url: `/api/v1/gmail/callback?code=x&state=${encodeURIComponent(revokedState)}`,
        headers: { cookie: a.cookie },
      });
      assert.equal(revoked.statusCode, 401);

      const freshA = await login(app, emailA);
      const validState = await startConnect(app, freshA);
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "synthetic-access",
              refresh_token: "synthetic-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ emailAddress: "gmail.synthetic@example.test" }),
          { status: 200 },
        );
      }) as typeof fetch;
      try {
        const valid = await app.inject({
          method: "GET",
          url: `/api/v1/gmail/callback?code=synthetic&state=${encodeURIComponent(validState)}`,
          headers: { cookie: freshA.cookie },
        });
        assert.equal(valid.statusCode, 303);
      } finally {
        globalThis.fetch = previousFetch;
      }
      const connections = await new SourceRepository(pool).listConnections(
        userA,
      );
      assert.equal(connections.length, 1);
      assert.equal(connections[0]?.state, "active");
      const notificationData = Buffer.from(
        JSON.stringify({
          emailAddress: "gmail.synthetic@example.test",
          historyId: "77",
        }),
      ).toString("base64");
      const rejectedPush = await app.inject({
        method: "POST",
        url: "/webhooks/google/gmail",
        payload: { message: { data: notificationData } },
      });
      assert.equal(rejectedPush.statusCode, 401);
      const acceptedPush = await app.inject({
        method: "POST",
        url: "/webhooks/google/gmail",
        headers: { authorization: "Bearer synthetic-push-token" },
        payload: { message: { data: notificationData } },
      });
      assert.equal(acceptedPush.statusCode, 204);
      assert.deepEqual(notifications, [
        { emailAddress: "gmail.synthetic@example.test", historyId: "77" },
      ]);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
