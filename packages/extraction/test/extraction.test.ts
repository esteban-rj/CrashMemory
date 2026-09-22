import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeStructuredModel,
  ModelGateway,
  loadRemoteModelConfig,
} from "@crashmemory/model-gateway";
import {
  ExtractionService,
  parseCivilDate,
  parseLocalizedMoney,
  parseTextPdf,
  sha256Text,
} from "../src/index.ts";

const body = "Factura de agua COP $ 48.250,50 vence el 15 de octubre de 2026.";
const amountStart = body.indexOf("COP");

test("extracts only a candidate whose exact body evidence verifies", async () => {
  const service = new ExtractionService(
    new ModelGateway({
      local: new FakeStructuredModel({
        value: {
          candidates: [
            {
              title: "Factura de agua",
              amount: { amount: "48250.50", currency: "COP" },
              due: {
                kind: "civil_date",
                date: "2026-10-15",
                timeZone: "America/Bogota",
              },
              evidence: [
                {
                  source: "body",
                  attachmentId: null,
                  page: null,
                  startOffset: amountStart,
                  endOffset: body.length,
                },
              ],
              ambiguous: false,
            },
          ],
        },
      }),
      remoteConfig: loadRemoteModelConfig({}),
    }),
  );
  const result = await service.extract({
    profile: "local-only",
    userId: "u",
    operationKey: "o",
    attemptNumber: 1,
    document: {
      sourceItemRevisionId: "r",
      body: { text: body, contentSha256: sha256Text(body) },
      pdfPages: [],
      userTimeZone: "America/Bogota",
    },
  });
  assert.equal(
    result.candidates[0]?.evidence[0]?.quote,
    body.slice(amountStart),
  );
  assert.equal(result.reviewRequired.length, 0);
});

test("rejects invalid offsets and ambiguity for manual review", async () => {
  const service = new ExtractionService(
    new ModelGateway({
      local: new FakeStructuredModel({
        value: {
          candidates: [
            {
              title: "Factura",
              amount: { amount: "1", currency: "USD" },
              due: {
                kind: "civil_date",
                date: "2026-10-15",
                timeZone: "America/Bogota",
              },
              evidence: [
                {
                  source: "body",
                  attachmentId: null,
                  page: null,
                  startOffset: 0,
                  endOffset: body.length + 1,
                },
              ],
              ambiguous: true,
            },
          ],
        },
      }),
      remoteConfig: loadRemoteModelConfig({}),
    }),
  );
  const result = await service.extract({
    profile: "local-only",
    userId: "u",
    operationKey: "o",
    attemptNumber: 1,
    document: {
      sourceItemRevisionId: "r",
      body: { text: body, contentSha256: sha256Text(body) },
      pdfPages: [],
      userTimeZone: "America/Bogota",
    },
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.reviewRequired[0]?.code, "invalid_evidence");
});

test("preserves a PDF page, UTF-16 offsets and that page hash in evidence", async () => {
  const page = "Factura COP 100 vence 2026-10-15";
  const start = page.indexOf("COP");
  const service = new ExtractionService(
    new ModelGateway({
      local: new FakeStructuredModel({
        value: {
          candidates: [
            {
              title: "Factura PDF",
              amount: { amount: "100", currency: "COP" },
              due: {
                kind: "civil_date",
                date: "2026-10-15",
                timeZone: "America/Bogota",
              },
              evidence: [
                {
                  source: "pdf",
                  attachmentId: "attachment",
                  page: 2,
                  startOffset: start,
                  endOffset: page.length,
                },
              ],
              ambiguous: false,
            },
          ],
        },
      }),
      remoteConfig: loadRemoteModelConfig({}),
    }),
  );
  const result = await service.extract({
    profile: "local-only",
    userId: "u",
    operationKey: "o",
    attemptNumber: 1,
    document: {
      sourceItemRevisionId: "r",
      body: { text: "", contentSha256: sha256Text("") },
      pdfPages: [
        {
          attachmentId: "attachment",
          page: 2,
          text: page,
          contentSha256: sha256Text(page),
        },
      ],
      userTimeZone: "America/Bogota",
    },
  });
  assert.deepEqual(result.candidates[0]?.evidence[0], {
    kind: "pdf_text_fragment",
    sourceItemRevisionId: "r",
    attachmentId: "attachment",
    page: 2,
    startOffset: start,
    endOffset: page.length,
    quote: page.slice(start),
    contentSha256: sha256Text(page),
  });
});

test("parses localized money and civil dates without assigning a bare dollar currency", () => {
  assert.deepEqual(parseLocalizedMoney("COP $ 1.234,50"), {
    amount: "1234.50",
    currency: "COP",
  });
  assert.equal(parseLocalizedMoney("$ 1.234,50"), null);
  assert.deepEqual(parseCivilDate("vence 15/10/2026", "America/Bogota"), {
    kind: "civil_date",
    date: "2026-10-15",
    timeZone: "America/Bogota",
  });
});

test("scanned or unsupported PDFs are reported for manual review instead of OCR", async () => {
  assert.deepEqual(
    await parseTextPdf(Buffer.from("%PDF-1.7\nimage only", "ascii")),
    {
      pages: [],
      manualReview: true,
    },
  );
});
