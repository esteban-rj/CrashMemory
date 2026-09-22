import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  DueValueSchema,
  MoneySchema,
  type DueValue,
  type Money,
} from "@crashmemory/contracts";
import {
  ModelGateway,
  type ModelPrivacyProfile,
} from "@crashmemory/model-gateway";
import { z } from "zod";
import { ExtractionRepository } from "@crashmemory/db";

export interface TextSource {
  text: string;
  contentSha256: string;
}

export interface PdfPageText extends TextSource {
  attachmentId: string;
  page: number;
}

export interface ExtractionDocument {
  sourceItemRevisionId: string;
  body: TextSource;
  pdfPages: PdfPageText[];
  userTimeZone: string;
}

const rawEvidenceSchema = z
  .object({
    source: z.enum(["body", "pdf"]),
    attachmentId: z.string().min(1).nullable(),
    page: z.number().int().positive().nullable(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict();

const rawCandidateSchema = z
  .object({
    title: z.string().min(1).max(500),
    amount: MoneySchema.nullable(),
    due: DueValueSchema.nullable(),
    evidence: z.array(rawEvidenceSchema).min(1),
    ambiguous: z.boolean().default(false),
  })
  .strict();

export const ModelExtractionSchema = z
  .object({ candidates: z.array(rawCandidateSchema).max(20) })
  .strict();

type RawCandidate = z.infer<typeof rawCandidateSchema>;

export interface VerifiedEvidence {
  kind: "email_body_fragment" | "pdf_text_fragment";
  sourceItemRevisionId: string;
  attachmentId?: string;
  page?: number;
  startOffset: number;
  endOffset: number;
  quote: string;
  contentSha256: string;
}

export interface ObligationCandidate {
  title: string;
  amount: Money;
  due: DueValue;
  evidence: VerifiedEvidence[];
  reviewState: "ready" | "manual_review";
  reasons: string[];
}

export interface ExtractionResult {
  candidates: ObligationCandidate[];
  reviewRequired: Array<{
    code:
      | "ambiguous_candidate"
      | "unsupported_currency"
      | "missing_verifiable_fields"
      | "invalid_evidence"
      | "pdf_requires_manual_review";
    attachmentId?: string;
  }>;
}

const modelJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "amount", "due", "evidence", "ambiguous"],
        properties: {
          title: { type: "string", maxLength: 500 },
          amount: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["amount", "currency"],
                properties: {
                  amount: { type: "string" },
                  currency: { type: "string" },
                },
              },
            ],
          },
          due: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "date", "timeZone"],
                properties: {
                  kind: { const: "civil_date" },
                  date: { type: "string" },
                  timeZone: { type: "string" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "at", "timeZone"],
                properties: {
                  kind: { const: "instant" },
                  at: { type: "string" },
                  timeZone: { type: "string" },
                },
              },
            ],
          },
          ambiguous: { type: "boolean" },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "source",
                "attachmentId",
                "page",
                "startOffset",
                "endOffset",
              ],
              properties: {
                source: { type: "string", enum: ["body", "pdf"] },
                attachmentId: { type: ["string", "null"] },
                page: { type: ["integer", "null"], minimum: 1 },
                startOffset: { type: "integer", minimum: 0 },
                endOffset: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
};

function sourceText(document: ExtractionDocument): string {
  return [
    "EMAIL BODY:",
    `USER TIME ZONE: ${document.userTimeZone}`,
    document.body.text,
    ...document.pdfPages.flatMap((page) => [
      `PDF attachment=${page.attachmentId} page=${page.page}:`,
      page.text,
    ]),
  ].join("\n");
}

function verifyEvidence(
  reference: z.infer<typeof rawEvidenceSchema>,
  document: ExtractionDocument,
): VerifiedEvidence | null {
  let source: TextSource | undefined;
  if (reference.source === "body") {
    if (reference.attachmentId !== null || reference.page !== null) return null;
    source = document.body;
  } else {
    if (!reference.attachmentId || !reference.page) return null;
    source = document.pdfPages.find(
      (page) =>
        page.attachmentId === reference.attachmentId &&
        page.page === reference.page,
    );
  }
  if (
    !source ||
    reference.endOffset <= reference.startOffset ||
    reference.endOffset > source.text.length
  ) {
    return null;
  }
  const quote = source.text.slice(reference.startOffset, reference.endOffset);
  if (!quote.trim()) return null;
  return {
    kind:
      reference.source === "body" ? "email_body_fragment" : "pdf_text_fragment",
    sourceItemRevisionId: document.sourceItemRevisionId,
    attachmentId:
      reference.source === "pdf"
        ? (reference.attachmentId ?? undefined)
        : undefined,
    page:
      reference.source === "pdf" ? (reference.page ?? undefined) : undefined,
    startOffset: reference.startOffset,
    endOffset: reference.endOffset,
    quote,
    contentSha256: source.contentSha256,
  };
}

function candidateFromRaw(
  candidate: RawCandidate,
  document: ExtractionDocument,
):
  ObligationCandidate | { reason: ExtractionResult["reviewRequired"][number] } {
  const evidence = candidate.evidence.map((reference) =>
    verifyEvidence(reference, document),
  );
  if (evidence.some((item) => item === null))
    return { reason: { code: "invalid_evidence" } };
  const verified = evidence as VerifiedEvidence[];
  if (!candidate.amount || !candidate.due) {
    return { reason: { code: "missing_verifiable_fields" } };
  }
  if (candidate.ambiguous) return { reason: { code: "ambiguous_candidate" } };
  const support = verified.map((item) => item.quote).join("\n");
  if (
    !supportsMoney(support, candidate.amount) ||
    !supportsDue(support, candidate.due)
  ) {
    return { reason: { code: "missing_verifiable_fields" } };
  }
  return {
    title: candidate.title,
    amount: candidate.amount,
    due: candidate.due,
    evidence: verified,
    reviewState: "ready",
    reasons: [],
  };
}

function supportsMoney(text: string, money: Money): boolean {
  const parsed = parseLocalizedMoney(text);
  return parsed?.currency === money.currency && parsed.amount === money.amount;
}

function supportsDue(text: string, due: DueValue): boolean {
  if (due.kind === "civil_date") {
    const parsed = parseCivilDate(text, due.timeZone);
    return parsed?.kind === "civil_date" && parsed.date === due.date;
  }
  return text.includes(due.at);
}

export class ExtractionService {
  constructor(private readonly gateway: ModelGateway) {}

  async extract(input: {
    profile: ModelPrivacyProfile;
    userId: string;
    operationKey: string;
    attemptNumber: number;
    document: ExtractionDocument;
  }): Promise<ExtractionResult> {
    const raw = await this.gateway.structured({
      profile: input.profile,
      userId: input.userId,
      operationKey: input.operationKey,
      attemptNumber: input.attemptNumber,
      request: {
        instructions:
          "Identify one payable obligation only when title, positive amount with ISO currency, due date and exact supporting offsets are present. Offsets are UTF-16 code units relative to exactly one body or PDF page source. A date without a time is a civil date in the supplied user timezone. Do not infer a currency from a bare dollar sign. Mark ambiguity true when more than one interpretation is plausible.",
        document: sourceText(input.document),
        schemaName: "crashmemory_obligation_extraction",
        schema: modelJsonSchema,
      },
      output: ModelExtractionSchema,
    });
    const result: ExtractionResult = { candidates: [], reviewRequired: [] };
    for (const candidate of raw.candidates) {
      const built = candidateFromRaw(candidate, input.document);
      if ("reason" in built) result.reviewRequired.push(built.reason);
      else result.candidates.push(built);
    }
    return result;
  }
}

/** Runs remote/local extraction between durable claim and completion transactions. */
export class DurableExtractionRunner {
  constructor(
    private readonly service: ExtractionService,
    private readonly repository: ExtractionRepository,
    private readonly documents: {
      load(
        userId: string,
        sourceItemRevisionId: string,
      ): Promise<ExtractionDocument | null>;
    },
  ) {}

  async runOne(): Promise<"idle" | "completed" | "manual_review"> {
    const job = await this.repository.claimNext();
    if (!job) return "idle";
    try {
      const document = await this.documents.load(
        job.userId,
        job.sourceItemRevisionId,
      );
      if (!document) {
        await this.repository.fail(job.id, job.userId, "input_unavailable");
        return "manual_review";
      }
      const result = await this.service.extract({
        profile: job.privacyProfile,
        userId: job.userId,
        operationKey: job.id,
        attemptNumber: 1,
        document,
      });
      if (result.reviewRequired.length > 0) {
        await this.repository.fail(
          job.id,
          job.userId,
          result.reviewRequired[0]?.code ?? "no_candidate",
        );
        return "manual_review";
      }
      if (result.candidates.length === 0) {
        await this.repository.complete({
          jobId: job.id,
          userId: job.userId,
          candidates: [],
        });
        return "completed";
      }
      await this.repository.complete({
        jobId: job.id,
        userId: job.userId,
        candidates: result.candidates.map((candidate) => ({
          id: randomUUID(),
          title: candidate.title,
          amount: candidate.amount,
          due: candidate.due,
          evidence: candidate.evidence.map((evidence) => ({
            ...evidence,
            id: randomUUID(),
          })),
        })),
      });
      return "completed";
    } catch (error) {
      const code = error instanceof Error ? error.name : "extraction_failed";
      await this.repository.fail(job.id, job.userId, code);
      return "manual_review";
    }
  }
}

/** Normalizes amounts found in locally formatted source text, never guessing a currency. */
export function parseLocalizedMoney(text: string): Money | null {
  const match =
    /(?:\b(COP|USD|EUR)\b\s*)?(?:\$\s*)?([0-9][0-9.,\s]{0,30})/i.exec(text);
  if (!match?.[1]) return null;
  const currency = match[1].toUpperCase();
  const value = match[2].replace(/\s/g, "");
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  let amount: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    amount = value
      .replace(decimal === "," ? /\./g : /,/g, "")
      .replace(decimal, ".");
  } else if (lastComma >= 0) {
    const trailing = value.length - lastComma - 1;
    amount =
      trailing === 2
        ? value.replace(".", "").replace(",", ".")
        : value.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const trailing = value.length - lastDot - 1;
    amount =
      trailing === 2 ? value.replace(/,/g, "") : value.replace(/\./g, "");
  } else amount = value;
  try {
    return MoneySchema.parse({ amount, currency });
  } catch {
    return null;
  }
}

export function parseCivilDate(
  text: string,
  timeZone: string,
): DueValue | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
  const months: Record<string, string> = {
    enero: "01",
    febrero: "02",
    marzo: "03",
    abril: "04",
    mayo: "05",
    junio: "06",
    julio: "07",
    agosto: "08",
    septiembre: "09",
    octubre: "10",
    noviembre: "11",
    diciembre: "12",
  };
  const named = /\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(20\d{2})\b/i.exec(
    text,
  );
  const date = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : slash
      ? `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`
      : named && months[named[2].toLowerCase()]
        ? `${named[3]}-${months[named[2].toLowerCase()]}-${named[1].padStart(2, "0")}`
        : undefined;
  if (!date) return null;
  try {
    return DueValueSchema.parse({ kind: "civil_date", date, timeZone });
  } catch {
    return null;
  }
}

/** PDF.js preserves page order and Unicode; OCR stays out of scope. */
export async function parseTextPdf(bytes: Uint8Array): Promise<{
  pages: string[];
  manualReview: boolean;
}> {
  if (bytes.byteLength > 10 * 1024 * 1024)
    return { pages: [], manualReview: true };
  try {
    const pdf = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
    }).promise;
    if (pdf.numPages > 100) return { pages: [], manualReview: true };
    const pages: string[] = [];
    let total = 0;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const content = await (await pdf.getPage(pageNo)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
      total += text.length;
      if (total > 250_000) return { pages: [], manualReview: true };
      pages.push(text);
    }
    return { pages, manualReview: pages.every((page) => !page.trim()) };
  } catch {
    return { pages: [], manualReview: true };
  }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
