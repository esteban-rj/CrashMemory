import {
  DueValueSchema,
  MoneySchema,
  type DueValue,
  type Money,
} from "@crashmemory/contracts";

export const USER_STATES = ["active", "disabled"] as const;
export const CONNECTION_STATES = [
  "pending",
  "active",
  "revoked",
  "error",
] as const;
export const REMINDER_STATES = [
  "scheduled",
  "cancelled",
  "delivering",
  "resolved",
] as const;

export type UserState = (typeof USER_STATES)[number];
export type ConnectionState = (typeof CONNECTION_STATES)[number];
export type ReminderState = (typeof REMINDER_STATES)[number];

export interface StoredDueValue {
  dueKind: DueValue["kind"] | null;
  dueDate: string | null;
  dueAt: string | null;
  timeZone: string | null;
}

export function normalizeMoney(value: Money | undefined): Money | undefined {
  return value === undefined ? undefined : MoneySchema.parse(value);
}

export function toStoredDue(value: DueValue | undefined): StoredDueValue {
  if (value === undefined) {
    return { dueKind: null, dueDate: null, dueAt: null, timeZone: null };
  }

  const due = DueValueSchema.parse(value);
  if (due.kind === "civil_date") {
    return {
      dueKind: due.kind,
      dueDate: due.date,
      dueAt: null,
      timeZone: due.timeZone,
    };
  }
  return {
    dueKind: due.kind,
    dueDate: null,
    dueAt: due.at,
    timeZone: due.timeZone,
  };
}

export function fromStoredDue(value: StoredDueValue): DueValue | undefined {
  if (value.dueKind === null) return undefined;
  if (value.dueKind === "civil_date") {
    return DueValueSchema.parse({
      kind: value.dueKind,
      date: value.dueDate,
      timeZone: value.timeZone,
    });
  }
  return DueValueSchema.parse({
    kind: value.dueKind,
    at: value.dueAt,
    timeZone: value.timeZone,
  });
}
