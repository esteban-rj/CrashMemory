import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createPool,
  migrate,
  SessionRepository,
  SourceRepository,
} from "@crashmemory/db";
import { MemoryObjectStorage } from "@crashmemory/runtime";
import { hashOpaqueToken } from "@crashmemory/security";
import { buildApp } from "../src/app.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const origin = "http://127.0.0.1:3001";

test(
  "obligation HTTP isolates owners, exposes evidence and protects concurrent mutations",
  { skip: !databaseUrl },
  async () => {
    const pool = createPool(databaseUrl!);
    const storage = new MemoryObjectStorage();
    const users = [randomUUID(), randomUUID()];
    const sessions: Array<{ id: string; cookie: string; csrf: string }> = [];
    try {
      await migrate(pool);
      for (const userId of users) {
        await pool.query(
          "INSERT INTO users(id,email_normalized,password_hash,time_zone) VALUES ($1,$2,'synthetic','America/Bogota')",
          [userId, `${userId}@example.test`],
        );
        const token = randomUUID();
        const csrf = randomUUID();
        const id = randomUUID();
        await new SessionRepository(pool).create({
          id,
          userId,
          tokenHash: hashOpaqueToken(token),
          csrfTokenHash: hashOpaqueToken(csrf),
          expiresAt: new Date(Date.now() + 3600_000),
        });
        sessions.push({ id, cookie: `crashmemory_test=${token}`, csrf });
      }
      const owner = users[0]!;
      const sources = new SourceRepository(pool);
      const connectionId = randomUUID();
      await sources.createConnection({
        id: connectionId,
        userId: owner,
        externalAccountId: "synthetic@gmail.test",
        state: "active",
      });
      const text = "Acme Agua Factura INV-9001 COP 48.50 vence 2026-10-15";
      const bytes = Buffer.from(text);
      const blobId = randomUUID();
      const key = `users/${owner}/blobs/${blobId}`;
      await storage.putIfAbsent(key, bytes);
      await sources.createBlob({
        id: blobId,
        userId: owner,
        storageKey: key,
        contentType: "text/plain",
        byteSize: bytes.length,
        contentSha256: sha(text),
      });
      const itemId = randomUUID();
      const sourceRevisionId = randomUUID();
      await sources.createItem({
        id: itemId,
        userId: owner,
        sourceConnectionId: connectionId,
        externalId: "synthetic-message",
      });
      await sources.createRevision({
        id: sourceRevisionId,
        userId: owner,
        sourceItemId: itemId,
        revision: 1,
        originalBlobId: blobId,
        contentSha256: sha(text),
        observedAt: new Date(),
      });
      await sources.createNormalizedBody({
        id: randomUUID(),
        userId: owner,
        sourceItemRevisionId: sourceRevisionId,
        bodyBlobId: blobId,
        contentSha256: sha(text),
        utf16Length: text.length,
        normalizationVersion: "v1",
      });
      await pool.query(
        `INSERT INTO extraction_jobs(id,user_id,source_item_revision_id,privacy_profile,state,last_error_code)
       VALUES ($1,$2,$3,'local-only','manual_review','pdf_requires_manual_review')`,
        [randomUUID(), owner, sourceRevisionId],
      );
      const evidenceId = randomUUID();
      await pool.query(
        `INSERT INTO evidence(id,user_id,source_item_revision_id,kind,start_offset,end_offset,quote,content_sha256)
       VALUES ($1,$2,$3,'email_body_fragment',0,$4,$5,$6)`,
        [evidenceId, owner, sourceRevisionId, text.length, text, sha(text)],
      );
      async function obligation() {
        const id = randomUUID();
        const versionId = randomUUID();
        await pool.query(
          "INSERT INTO obligations(id,user_id,state) VALUES ($1,$2,'candidate')",
          [id, owner],
        );
        await pool.query(
          `INSERT INTO obligation_versions(id,user_id,obligation_id,revision,state,title,amount,currency,due_kind,due_date,time_zone)
         VALUES ($1,$2,$3,1,'candidate','Factura de agua','48.50','COP','civil_date','2026-10-15','America/Bogota')`,
          [versionId, owner, id],
        );
        await pool.query(
          "INSERT INTO obligation_version_evidence(user_id,obligation_version_id,evidence_id) VALUES ($1,$2,$3)",
          [owner, versionId, evidenceId],
        );
        await pool.query(
          "UPDATE obligations SET current_version_id=$2,updated_at='2026-09-20T10:00:00.123456Z' WHERE id=$1",
          [id, versionId],
        );
        return id;
      }
      const first = await obligation();
      const second = await obligation();
      const app = buildApp({
        pool,
        objectStorage: storage,
        auth: {
          appOrigin: origin,
          cookieName: "crashmemory_test",
          cookieSecure: false,
          sessionTtlSeconds: 3600,
        },
      });
      await app.ready();
      try {
        const a = sessions[0]!;
        const b = sessions[1]!;
        const get = (url: string, cookie = a.cookie) =>
          app.inject({ method: "GET", url, headers: { cookie } });
        const list = await get("/api/v1/obligations?limit=1");
        assert.equal(list.statusCode, 200);
        assert.equal(list.headers["cache-control"], "no-store");
        assert.equal(list.json().data[0].due.date, "2026-10-15");
        const next = list.json().meta.nextCursor;
        assert.ok(next, list.body);
        const nextPage = await get(
          `/api/v1/obligations?limit=1&cursor=${encodeURIComponent(next)}`,
        );
        assert.equal(nextPage.statusCode, 200, nextPage.body);
        assert.equal(nextPage.json().data.length, 1);
        assert.notEqual(
          nextPage.json().data[0].obligationId,
          list.json().data[0].obligationId,
        );
        assert.equal(
          (await get("/api/v1/obligations", b.cookie)).json().data.length,
          0,
        );
        const reviews = await get("/api/v1/extraction/reviews");
        assert.equal(
          reviews.json().data[0].reasonCode,
          "pdf_requires_manual_review",
        );
        assert.equal(
          reviews.json().data[0].sourceItemRevisionId,
          sourceRevisionId,
        );
        assert.equal(
          (await get("/api/v1/extraction/reviews", b.cookie)).json().data
            .length,
          0,
        );
        assert.equal(
          (await get(`/api/v1/obligations/${first}`, b.cookie)).statusCode,
          404,
        );
        assert.equal(
          (await get(`/api/v1/evidence/${evidenceId}`, b.cookie)).statusCode,
          404,
        );
        assert.equal((await get("/api/v1/obligations/bad")).statusCode, 400);
        const detail = await get(`/api/v1/obligations/${first}`);
        assert.equal(detail.json().data.versions[0].evidence[0].quote, text);
        assert.equal(detail.json().data.versions[0].due.date, "2026-10-15");
        const evidence = await get(`/api/v1/evidence/${evidenceId}`);
        assert.equal(evidence.json().data.contentSha256, sha(text));
        assert.equal(
          (await get(`/api/v1/evidence/${evidenceId}/text`)).json().data.text,
          text,
        );
        assert.equal(
          (await get(`/api/v1/evidence/${evidenceId}/source`)).body,
          text,
        );

        const post = (
          action: string,
          payload: object,
          headers: Record<string, string> = {},
        ) =>
          app.inject({
            method: "POST",
            url: `/api/v1/obligations/${first}/${action}`,
            headers: {
              cookie: a.cookie,
              origin,
              "content-type": "application/json",
              "x-csrf-token": a.csrf,
              ...headers,
            },
            payload,
          });
        assert.equal(
          (
            await post(
              "confirm",
              { expectedVersion: 1 },
              { "x-csrf-token": "" },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await post(
              "confirm",
              { expectedVersion: 1 },
              { origin: "https://evil.test" },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await post(
              "confirm",
              { expectedVersion: 1 },
              { "content-type": "text/plain" },
            )
          ).statusCode,
          415,
        );
        const confirmed = await post("confirm", { expectedVersion: 1 });
        assert.equal(confirmed.statusCode, 200);
        assert.equal(confirmed.json().data.revision, 2);
        assert.equal(confirmed.json().data.state, "confirmed");
        assert.equal(
          (
            await post("correct", {
              expectedVersion: 1,
              changes: { title: "Otra" },
            })
          ).statusCode,
          409,
        );
        const corrected = await post("correct", {
          expectedVersion: 2,
          changes: {
            amount: { amount: "50.00", currency: "COP" },
          },
        });
        assert.equal(corrected.statusCode, 200);
        const after = await get(`/api/v1/obligations/${first}`);
        assert.equal(after.json().data.versions[0].amount.amount, "50.00");
        assert.equal(after.json().data.protectedFields.length, 3);
        assert.equal(after.json().data.versions.length, 3);
        assert.equal(
          (await post("pay", { expectedVersion: 3 })).statusCode,
          200,
        );
        assert.equal(
          (await post("discard", { expectedVersion: 4 })).statusCode,
          409,
        );
        assert.equal(
          (await get(`/api/v1/obligations/${first}/conflicts`)).json().data
            .length,
          0,
        );
        assert.equal(
          (await get(`/api/v1/obligations/${second}`, b.cookie)).statusCode,
          404,
        );
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
    }
  },
);
