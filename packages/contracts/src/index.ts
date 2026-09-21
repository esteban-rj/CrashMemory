import { z } from "zod";

export const CONTRACT_VERSION = "2026-09-20.v1" as const;
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function isCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const DecimalSchema = z
  .string()
  .regex(decimalPattern, "Must be an exact base-10 decimal string");
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Must be an ISO 4217 alphabetic code");
export const MoneySchema = z
  .object({
    amount: DecimalSchema.refine(
      (value) => !value.startsWith("-") && /[1-9]/.test(value),
      "Must be greater than zero",
    ),
    currency: CurrencyCodeSchema,
  })
  .strict();

export const TimeZoneSchema = z
  .string()
  .min(1)
  .refine(isIanaTimeZone, "Must be a valid IANA time zone");
export const CivilDateSchema = z
  .string()
  .refine(isCivilDate, "Must be a real YYYY-MM-DD calendar date");
export const DueValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("civil_date"),
      date: CivilDateSchema,
      timeZone: TimeZoneSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("instant"),
      at: z.iso.datetime({ offset: true }),
      timeZone: TimeZoneSchema,
    })
    .strict(),
]);

export const EvidenceKindSchema = z.enum([
  "email_body_fragment",
  "pdf_text_fragment",
]);
export const EvidenceReferenceSchema = z
  .object({
    id: z.string().min(1),
    sourceItemRevisionId: z.string().min(1),
    kind: EvidenceKindSchema,
    attachmentId: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    quote: z.string().min(1).max(4_000),
    contentSha256: z.string().regex(sha256Pattern),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.endOffset <= evidence.startOffset) {
      context.addIssue({
        code: "custom",
        path: ["endOffset"],
        message: "Must be greater than startOffset",
      });
    }
    if (
      evidence.kind === "pdf_text_fragment" &&
      (!evidence.attachmentId || !evidence.page)
    ) {
      context.addIssue({
        code: "custom",
        message: "PDF evidence requires attachmentId and page",
      });
    }
  });

export const ObligationStateSchema = z.enum([
  "candidate",
  "confirmed",
  "conflict",
  "paid",
  "discarded",
]);
export const ObligationSummarySchema = z
  .object({
    id: z.string().min(1),
    currentVersionId: z.string().min(1),
    state: ObligationStateSchema,
    title: z.string().min(1).max(500),
    amount: MoneySchema.optional(),
    due: DueValueSchema.optional(),
    evidenceIds: z.array(z.string().min(1)).min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const OutboxEventTypeSchema = z.enum([
  "source.item.revision.created.v1",
  "obligation.candidate.created.v1",
  "obligation.version.created.v1",
  "obligation.reminder.reschedule.requested.v1",
  "reminder.delivery.requested.v1",
  "reminder.delivery.resolved.v1",
]);

const EventBaseSchema = z
  .object({
    id: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    userId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict();

export const OutboxEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("source.item.revision.created.v1"),
    aggregateType: z.literal("source_item"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        sourceItemId: z.string().min(1),
        sourceItemRevisionId: z.string().min(1),
      })
      .strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("obligation.candidate.created.v1"),
    aggregateType: z.literal("obligation"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        obligationId: z.string().min(1),
        sourceItemRevisionId: z.string().min(1),
      })
      .strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("obligation.version.created.v1"),
    aggregateType: z.literal("obligation"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        obligationId: z.string().min(1),
        obligationVersionId: z.string().min(1),
        revision: z.number().int().positive(),
      })
      .strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("obligation.reminder.reschedule.requested.v1"),
    aggregateType: z.literal("obligation"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        obligationId: z.string().min(1),
        cause: z.enum(["due_changed", "paid", "discarded", "deleted"]),
      })
      .strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("reminder.delivery.requested.v1"),
    aggregateType: z.literal("reminder"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        reminderId: z.string().min(1),
        targetVersion: z.number().int().positive(),
      })
      .strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("reminder.delivery.resolved.v1"),
    aggregateType: z.literal("reminder"),
    aggregateId: z.string().min(1),
    payload: z
      .object({
        reminderId: z.string().min(1),
        attemptId: z.string().min(1),
        outcome: z.enum(["sent", "failed", "unknown"]),
      })
      .strict(),
  }),
]);

export type DecimalString = z.infer<typeof DecimalSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type DueValue = z.infer<typeof DueValueSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type ObligationSummary = z.infer<typeof ObligationSummarySchema>;
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;

export const demoObligation = ObligationSummarySchema.parse({
  id: "obl_demo_water_001",
  currentVersionId: "obv_demo_water_001",
  state: "candidate",
  title: "Factura de agua (demo)",
  amount: { amount: "48250.00", currency: "COP" },
  due: { kind: "civil_date", date: "2026-10-15", timeZone: "America/Bogota" },
  evidenceIds: ["ev_demo_water_001"],
  revision: 1,
});
