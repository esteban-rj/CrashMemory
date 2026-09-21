import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { UserRepository, createPool, migrate } from "@crashmemory/db";
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
