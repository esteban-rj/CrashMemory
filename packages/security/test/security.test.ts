import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  CredentialCipher,
  OAuthStateSigner,
  hashOpaqueToken,
  hashPassword,
  redactSecrets,
  safeErrorSerializer,
  safeRequestSerializer,
  safeTokenEqual,
  verifyPassword,
} from "../src/index.ts";

test("password hashes are salted, adaptive and verifiable", async () => {
  const first = await hashPassword("synthetic-password-1");
  const second = await hashPassword("synthetic-password-1");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("synthetic-password-1", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});

test("opaque tokens are compared through their hashes", () => {
  const token = "synthetic-session-token";
  assert.equal(safeTokenEqual(token, hashOpaqueToken(token)), true);
  assert.equal(safeTokenEqual("different", hashOpaqueToken(token)), false);
});

test("credential encryption binds ciphertext to owner context", () => {
  const cipher = new CredentialCipher("v1", new Map([["v1", randomBytes(32)]]));
  const encrypted = cipher.encrypt(
    "synthetic-oauth-token",
    "user-a:connection-a",
  );
  assert.equal(
    cipher.decrypt(encrypted, "user-a:connection-a"),
    "synthetic-oauth-token",
  );
  assert.throws(() => cipher.decrypt(encrypted, "user-b:connection-a"));
});

test("OAuth state rejects tampering, expiry and external redirects", () => {
  const signer = new OAuthStateSigner(randomBytes(32));
  const state = signer.issue({
    userId: "user-a",
    sessionId: "session-a",
    provider: "gmail",
    redirectPath: "/settings/sources",
    nonce: "a".repeat(32),
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(signer.verify(state).userId, "user-a");
  const [payload, signature] = state.split(".");
  assert.ok(payload && signature);
  const alteredSignature = Buffer.from(signature, "base64url");
  alteredSignature[0] ^= 1;
  assert.throws(() =>
    signer.verify(`${payload}.${alteredSignature.toString("base64url")}`),
  );
  assert.throws(() => signer.verify(state, Date.now() + 120_000));
  assert.throws(() =>
    signer.issue({
      userId: "user-a",
      sessionId: "session-a",
      provider: "gmail",
      redirectPath: "https://example.test/capture",
      nonce: "a".repeat(32),
      expiresAt: Date.now() + 60_000,
    }),
  );
  assert.throws(() =>
    signer.issue({
      userId: "user-a",
      sessionId: "session-a",
      provider: "gmail",
      redirectPath: "/\\evil.example",
      nonce: "a".repeat(32),
      expiresAt: Date.now() + 60_000,
    }),
  );
});

test("structured redaction removes nested credentials from logs", () => {
  assert.deepEqual(
    redactSecrets({
      email: "person@example.test",
      nested: { refresh_token: "secret" },
    }),
    { email: "person@example.test", nested: { refresh_token: "[REDACTED]" } },
  );
});

test("log serializers omit query secrets, headers, bodies and database detail", () => {
  const sentinel = "SENTINEL_DO_NOT_LOG";
  const requestLog = safeRequestSerializer({
    id: "req-1",
    method: "GET",
    url: `/oauth/callback?code=${sentinel}&state=${sentinel}`,
    headers: { authorization: sentinel },
    body: { password: sentinel },
  });
  const errorLog = safeErrorSerializer({
    name: "DatabaseError",
    code: "23503",
    message: sentinel,
    detail: sentinel,
    stack: sentinel,
  });
  assert.equal(requestLog.path, "/oauth/callback");
  assert.equal(errorLog.code, "23503");
  assert.equal(
    JSON.stringify({ requestLog, errorLog }).includes(sentinel),
    false,
  );
});
