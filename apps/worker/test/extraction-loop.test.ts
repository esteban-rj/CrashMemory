import assert from "node:assert/strict";
import test from "node:test";
import { ExtractionLoop } from "../src/extraction-loop.ts";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("extraction loop recovers on subsequent ticks and never overlaps runs", async () => {
  let recoveries = 0;
  let runs = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = new ExtractionLoop(
    {
      recoverExpired: async () => {
        recoveries += 1;
        return 0;
      },
      runOne: async () => {
        runs += 1;
        if (runs === 1) await blocked;
      },
      report: () => assert.fail("a successful tick must not report"),
    },
    5,
  );
  const firstTick = loop.tick();
  await wait(1);
  await loop.tick();
  assert.equal(runs, 1);
  const stopping = loop.stop();
  release?.();
  await Promise.all([firstTick, stopping]);
  assert.equal(runs, 1);
  assert.equal(recoveries, 1);
});

test("extraction loop reports database errors and keeps periodic recovery alive", async () => {
  const reports: string[] = [];
  let recoveries = 0;
  const loop = new ExtractionLoop(
    {
      recoverExpired: async () => {
        recoveries += 1;
        if (recoveries === 1) {
          const error = Object.assign(new Error("synthetic db error"), {
            code: "08006",
          });
          throw error;
        }
        return 0;
      },
      runOne: async () => {},
      report: (_event, code) => reports.push(code),
    },
    5,
  );
  await loop.start();
  await wait(20);
  await loop.stop();
  assert.deepEqual(reports, ["08006"]);
  assert.ok(recoveries >= 2);
});
