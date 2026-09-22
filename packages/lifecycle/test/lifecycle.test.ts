import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedFileDeletionJournal,
  LifecycleJournalRequiredError,
  LifecycleService,
} from "../src/index.ts";

test("encrypted lifecycle journal is fsync-safe append-only and does not expose source identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crashmemory-v09-"));
  const path = join(directory, "journal.log");
  const journal = new EncryptedFileDeletionJournal(
    path,
    Buffer.alloc(32, 7).toString("base64"),
  );
  await journal.append({
    scope: "gmail_message",
    externalMessageId: "synthetic-message-42",
  });
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /synthetic-message-42/);
  assert.match(raw, /"iv"/);
  assert.match(raw, /"tag"/);
});

test("destructive lifecycle calls fail before database work without a durable journal", async () => {
  const service = new LifecycleService({} as never);
  await assert.rejects(
    service.disconnectGmail({
      userId: "00000000-0000-0000-0000-000000000001",
      connectionId: "00000000-0000-0000-0000-000000000002",
      actorSessionId: "00000000-0000-0000-0000-000000000003",
    }),
    LifecycleJournalRequiredError,
  );
});
