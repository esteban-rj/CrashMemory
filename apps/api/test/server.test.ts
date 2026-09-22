import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { createGooglePubSubTokenVerifier } from "../src/gmail.ts";

test("demo endpoints disclose that their data is synthetic and in-memory", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.deepEqual(health.json(), { status: "ok", mode: "demo" });

  const obligations = await app.inject({
    method: "GET",
    url: "/api/v1/demo/obligations",
  });
  assert.equal(obligations.statusCode, 200);
  assert.equal(obligations.json().meta.mode, "synthetic-demo");
  assert.equal(obligations.json().data[0].amount.amount, "48250.00");
});

test("Pub/Sub verifier binds the Google OIDC token to the configured service account", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        aud: "https://crashmemory.example/webhooks/google/gmail",
        iss: "https://accounts.google.com",
        email: "expected-push@example.iam.gserviceaccount.com",
        email_verified: "true",
        exp: String(Math.floor(Date.now() / 1000) + 60),
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const verifier = createGooglePubSubTokenVerifier(
      "https://crashmemory.example/webhooks/google/gmail",
      "expected-push@example.iam.gserviceaccount.com",
    );
    assert.equal(await verifier("Bearer synthetic.token.value"), true);
    const foreign = createGooglePubSubTokenVerifier(
      "https://crashmemory.example/webhooks/google/gmail",
      "other-push@example.iam.gserviceaccount.com",
    );
    assert.equal(await foreign("Bearer synthetic.token.value"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
