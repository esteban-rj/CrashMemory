import assert from "node:assert/strict";
import test from "node:test";
import {
  GmailHistoryExpiredError,
  GoogleGmailRemote,
  GmailSyncService,
  normalizeMessage,
  type GmailPersistence,
  type GmailRemote,
} from "../src/index.ts";

function b64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

test("normalizes nested MIME, preserves PDFs and counts UTF-16 body length", async () => {
  const normalized = await normalizeMessage(
    {
      id: "m-1",
      historyId: "8",
      raw: b64("From: synthetic@example.test\r\n\r\nraw"),
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/html", body: { data: b64("<p>hola</p>") } },
          { mimeType: "text/plain", body: { data: b64("Factura 😀\r\n\r\n") } },
          { mimeType: "text/plain", body: { attachmentId: "body-external" } },
          {
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            body: { attachmentId: "a-1" },
          },
        ],
      },
    },
    async (attachmentId) =>
      attachmentId === "body-external"
        ? new TextEncoder().encode("detalle externo")
        : new Uint8Array([37, 80, 68, 70]),
  );
  assert.equal(normalized.body, "Factura 😀\n\ndetalle externo");
  assert.equal(normalized.body.length, 27); // JavaScript UTF-16 code units.
  assert.equal(normalized.attachments[0]?.mediaType, "application/pdf");
  assert.deepEqual(
    [...normalized.original],
    [...Buffer.from("From: synthetic@example.test\r\n\r\nraw")],
  );
});

test("uses externally stored HTML as the body fallback", async () => {
  const normalized = await normalizeMessage(
    {
      id: "m-html",
      historyId: "9",
      payload: {
        mimeType: "text/html",
        body: { attachmentId: "html-external" },
      },
    },
    async () =>
      new TextEncoder().encode("<p>Factura <strong>externa</strong></p>"),
  );
  assert.equal(normalized.body, "Factura externa");
  assert.equal(normalized.attachments.length, 0);
});

test("downloads each attachmentId once while normalizing a message", async () => {
  const calls: string[] = [];
  const normalized = await normalizeMessage(
    {
      id: "m-once",
      historyId: "10",
      payload: {
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        body: { attachmentId: "pdf-1" },
      },
    },
    async (id) => {
      calls.push(id);
      return new Uint8Array([37, 80, 68, 70]);
    },
  );
  assert.deepEqual(calls, ["pdf-1"]);
  assert.equal(normalized.attachments[0]?.bytes.byteLength, 4);
});

test("Gmail persists bounded batches and leaves the cursor untouched after a late failure", async () => {
  const saved: string[][] = [];
  const cursors: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let failLast = true;
  const remote: GmailRemote = {
    async getProfile() {
      return { emailAddress: "synthetic@example.test", historyId: "20" };
    },
    async listMessages() {
      return { messageIds: [] };
    },
    async listHistory() {
      return {
        historyId: "21",
        messageIds: Array.from({ length: 100 }, (_, index) => `m-${index}`),
      };
    },
    async getMessage(id) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (id === "m-99" && failLast) throw new Error("late Gmail failure");
      return {
        id,
        historyId: "21",
        payload: { mimeType: "text/plain", body: { data: b64(id) } },
      };
    },
    async getAttachment() {
      return new Uint8Array();
    },
    async watch() {
      return { historyId: "21", expiration: new Date() };
    },
  };
  const persistence: GmailPersistence = {
    async persistPage({ messages }) {
      assert.ok(messages.length <= 4);
      saved.push(messages.map((message) => message.externalId));
    },
    async confirmCursor(value) {
      cursors.push(value);
    },
    async recordWatch() {},
    async recordSyncFailure() {},
  };
  const service = new GmailSyncService(remote, persistence);
  await assert.rejects(() => service.incremental("20"), /late Gmail failure/);
  assert.deepEqual(cursors, []);
  assert.equal(saved.length, 24);
  assert.equal(maximumActive, 4);
  failLast = false;
  await service.incremental("20");
  assert.deepEqual(cursors, ["21"]);
  assert.equal(saved.length, 49);
  assert.deepEqual(saved[0], saved[24]);
});

test("history cursor advances only after durable pages and replays duplicate notifications", async () => {
  const persisted: string[][] = [];
  const cursors: string[] = [];
  const persistence: GmailPersistence = {
    async persistPage({ messages }) {
      persisted.push(messages.map((message) => message.externalId));
    },
    async confirmCursor(value) {
      cursors.push(value);
    },
    async recordWatch() {},
    async recordSyncFailure() {},
  };
  const remote: GmailRemote = {
    async getProfile() {
      return { emailAddress: "synthetic@example.test", historyId: "10" };
    },
    async listMessages() {
      return { messageIds: [] };
    },
    async listHistory({ pageToken }) {
      return pageToken
        ? { historyId: "12", messageIds: ["m-2"] }
        : {
            historyId: "11",
            nextPageToken: "next",
            messageIds: ["m-1", "m-1"],
          };
    },
    async getMessage(id) {
      return {
        id,
        historyId: "12",
        payload: { mimeType: "text/plain", body: { data: b64(id) } },
      };
    },
    async getAttachment() {
      return new Uint8Array();
    },
    async watch() {
      return { historyId: "12", expiration: new Date("2026-10-01T00:00:00Z") };
    },
  };
  await new GmailSyncService(remote, persistence).incremental("10");
  assert.deepEqual(persisted, [["m-1"], ["m-2"]]);
  assert.deepEqual(cursors, ["12"]);
});

test("Google history advances past a deleted message while persisting its surviving sibling", async () => {
  const persisted: string[][] = [];
  const cursors: string[] = [];
  const persistence: GmailPersistence = {
    async persistPage({ messages }) {
      persisted.push(messages.map((message) => message.externalId));
    },
    async confirmCursor(value) {
      cursors.push(value);
    },
    async recordWatch() {},
    async recordSyncFailure() {},
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("history?")) {
      return new Response(
        JSON.stringify({
          historyId: "12",
          history: [
            {
              messages: [{ id: "deleted" }],
              messagesAdded: [{ message: { id: "new" } }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (value.includes("messages/deleted")) {
      return new Response(JSON.stringify({ error: { code: 404 } }), {
        status: 404,
      });
    }
    if (value.includes("messages/new?format=raw")) {
      return new Response(
        JSON.stringify({ raw: b64("From: synthetic\r\n\r\nnew") }),
        {
          status: 200,
        },
      );
    }
    if (value.includes("messages/new?format=full")) {
      return new Response(
        JSON.stringify({
          id: "new",
          historyId: "12",
          payload: { mimeType: "text/plain", body: { data: b64("new") } },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected Gmail request: ${value}`);
  }) as typeof fetch;
  try {
    const remote = new GoogleGmailRemote("synthetic-access-token");
    await new GmailSyncService(remote, persistence).incremental("10");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(persisted, [["new"]]);
  assert.deepEqual(cursors, ["12"]);
});

test("expired Gmail history records an explicit resync condition without moving the cursor", async () => {
  const failures: string[] = [];
  const persistence: GmailPersistence = {
    async persistPage() {},
    async confirmCursor() {
      throw new Error("cursor must not advance");
    },
    async recordWatch() {},
    async recordSyncFailure(code) {
      failures.push(code);
    },
  };
  const remote: GmailRemote = {
    async getProfile() {
      return { emailAddress: "synthetic@example.test", historyId: "10" };
    },
    async listMessages() {
      return { messageIds: [] };
    },
    async listHistory() {
      throw new GmailHistoryExpiredError();
    },
    async getMessage() {
      throw new Error("not reached");
    },
    async getAttachment() {
      return new Uint8Array();
    },
    async watch() {
      return { historyId: "10", expiration: new Date() };
    },
  };
  await assert.rejects(
    () => new GmailSyncService(remote, persistence).incremental("9"),
    GmailHistoryExpiredError,
  );
  assert.deepEqual(failures, ["history_not_found"]);
});

test("watch renewal records expiry without advancing the processed history cursor", async () => {
  const cursors: string[] = [];
  let expiration: Date | undefined;
  const persistence: GmailPersistence = {
    async persistPage() {},
    async confirmCursor(value) {
      cursors.push(value);
    },
    async recordWatch(input) {
      expiration = input.expiration;
    },
    async recordSyncFailure() {},
  };
  const remote: GmailRemote = {
    async getProfile() {
      return { emailAddress: "synthetic@example.test", historyId: "1" };
    },
    async listMessages() {
      return { messageIds: [] };
    },
    async listHistory() {
      return { messageIds: [] };
    },
    async getMessage() {
      throw new Error("not reached");
    },
    async getAttachment() {
      return new Uint8Array();
    },
    async watch() {
      return { historyId: "99", expiration: new Date("2026-10-01T00:00:00Z") };
    },
  };
  await new GmailSyncService(remote, persistence).renewWatch();
  assert.equal(expiration?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.deepEqual(cursors, []);
});
