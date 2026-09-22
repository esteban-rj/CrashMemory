import assert from "node:assert/strict";
import test from "node:test";
import { parseUtcInstant } from "../src/cli/model-budget-arguments.ts";

test("budget CLI accepts only real, explicit UTC period instants", () => {
  assert.equal(
    parseUtcInstant("2026-09-22T00:00:00Z", "--period-start").toISOString(),
    "2026-09-22T00:00:00.000Z",
  );

  assert.throws(
    () => parseUtcInstant("2026-02-30T00:00:00Z", "--period-start"),
    /real UTC calendar instant/,
  );
  assert.throws(
    () => parseUtcInstant("2026-09-22", "--period-start"),
    /UTC ISO-8601 instant/,
  );
  assert.throws(
    () => parseUtcInstant("2026-09-22T00:00:00-05:00", "--period-start"),
    /UTC ISO-8601 instant/,
  );
});
