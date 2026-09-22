import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  UserRepository,
  createPool,
  inTransaction,
  migrate,
  ReminderRepository,
} from "@crashmemory/db";
import { hashPassword } from "@crashmemory/security";
import { buildApp } from "../src/app.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "login and logout use an opaque cookie, trusted origin and CSRF",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const id = randomUUID();
    const email = `${id}@example.test`;
    await new UserRepository(pool).create({
      id,
      emailNormalized: email,
      passwordHash: await hashPassword("synthetic-login-password"),
      timeZone: "America/Bogota",
    });
    const app = buildApp({
      pool,
      auth: {
        appOrigin: "http://127.0.0.1:3001",
        cookieName: "crashmemory_v02_session",
        cookieSecure: false,
        sessionTtlSeconds: 3600,
      },
    });
    await app.ready();
    try {
      const rejectedOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        payload: { email, password: "synthetic-login-password" },
      });
      assert.equal(rejectedOrigin.statusCode, 403);

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
        },
        payload: { email, password: "synthetic-login-password" },
      });
      assert.equal(login.statusCode, 200);
      assert.equal(login.headers["x-crashmemory-contract"], "2026-09-20.v1");
      const cookie = login.headers["set-cookie"];
      assert.match(String(cookie), /HttpOnly/);
      assert.match(String(cookie), /SameSite=Lax/);
      assert.doesNotMatch(String(cookie), new RegExp(id));
      const csrfToken = login.json().data.csrfToken as string;

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
          cookie: String(cookie).split(";", 1)[0]!,
        },
        payload: {},
      });
      assert.equal(missingCsrf.statusCode, 403);

      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
          cookie: String(cookie).split(";", 1)[0]!,
          "x-csrf-token": csrfToken,
        },
        payload: {},
      });
      assert.equal(logout.statusCode, 200);
      assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);

test(
  "reminder status and attempts are paginated and never cross session ownership",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    await migrate(pool);
    const userA = randomUUID();
    const userB = randomUUID();
    const password = "synthetic-login-password";
    const createUser = (id: string) =>
      new UserRepository(pool).create({
        id,
        emailNormalized: `${id}@example.test`,
        passwordHash: "",
        timeZone: "America/Bogota",
      });
    const passwordHash = await hashPassword(password);
    await Promise.all([createUser(userA), createUser(userB)]);
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      userA,
      passwordHash,
    ]);
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      userB,
      passwordHash,
    ]);
    const seedReminder = async (userId: string) => {
      const obligationId = randomUUID();
      const versionId = randomUUID();
      const reminderId = randomUUID();
      await inTransaction(pool, async (client) => {
        await client.query(
          "INSERT INTO obligations(id, user_id, state) VALUES ($1, $2, 'confirmed')",
          [obligationId, userId],
        );
        await client.query(
          "INSERT INTO obligation_versions(id, user_id, obligation_id, revision, title, due_kind, due_at, time_zone) VALUES ($1, $2, $3, 1, 'Sintético', 'instant', now(), 'America/Bogota')",
          [versionId, userId, obligationId],
        );
        await client.query(
          "UPDATE obligations SET current_version_id = $1 WHERE id = $2",
          [versionId, obligationId],
        );
      });
      await new ReminderRepository(pool).create({
        id: reminderId,
        userId,
        obligationId,
        obligationVersionId: versionId,
        targetVersion: 1,
        scheduledFor: new Date(),
        policy: { id: "test" },
        dedupeKey: `test:${reminderId}`,
      });
      return reminderId;
    };
    const reminderA = await seedReminder(userA);
    const reminderB = await seedReminder(userB);
    const app = buildApp({
      pool,
      auth: {
        appOrigin: "http://127.0.0.1:3001",
        cookieName: "session",
        cookieSecure: false,
        sessionTtlSeconds: 3600,
      },
    });
    await app.ready();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
        },
        payload: { email: `${userA}@example.test`, password },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/telegram/status",
        headers: { cookie },
      });
      assert.deepEqual(status.json().data, { linked: false, linkedAt: null });
      const reminders = await app.inject({
        method: "GET",
        url: "/api/v1/reminders?limit=1",
        headers: { cookie },
      });
      assert.equal(reminders.statusCode, 200);
      assert.deepEqual(
        reminders.json().data.map((item: { id: string }) => item.id),
        [reminderA],
      );
      const foreignAttempts = await app.inject({
        method: "GET",
        url: `/api/v1/reminders/${reminderB}/attempts?limit=1`,
        headers: { cookie },
      });
      assert.deepEqual(foreignAttempts.json().data, []);
    } finally {
      await app.close();
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        [userA, userB],
      ]);
      await pool.end();
    }
  },
);
