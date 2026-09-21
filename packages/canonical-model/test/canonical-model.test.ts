import assert from "node:assert/strict";
import test from "node:test";
import { fromStoredDue, normalizeMoney, toStoredDue } from "../src/index.ts";

test("civil dates remain civil dates and never become UTC midnights", () => {
  const due = {
    kind: "civil_date" as const,
    date: "2026-10-15",
    timeZone: "America/Bogota",
  };
  assert.deepEqual(fromStoredDue(toStoredDue(due)), due);
  assert.equal(toStoredDue(due).dueAt, null);
});

test("money stays an exact decimal string", () => {
  assert.deepEqual(
    normalizeMoney({ amount: "9007199254740993.1200", currency: "COP" }),
    { amount: "9007199254740993.1200", currency: "COP" },
  );
});
