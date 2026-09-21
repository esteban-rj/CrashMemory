import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.ts";

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
