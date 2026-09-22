import { randomUUID } from "node:crypto";
import { createPool } from "../client.ts";
import { ModelBudgetRepository } from "../repositories.ts";

type Arguments = Record<string, string>;

function parseArguments(values: string[]): Arguments {
  const parsed: Arguments = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || parsed[key]) {
      throw new Error("Use named arguments exactly once");
    }
    parsed[key] = value;
  }
  return parsed;
}

function required(arguments_: Arguments, name: string): string {
  const value = arguments_[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function decimal(value: string, name: string): string {
  if (!/^\d+(?:\.\d{1,18})?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error(
      `${name} must be a positive decimal string with at most 18 decimals`,
    );
  }
  return value;
}

function instant(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be an ISO-8601 instant`);
  }
  return parsed;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const [command, ...rawValues] = process.argv.slice(2);
const values = rawValues[0] === "--" ? rawValues.slice(1) : rawValues;
const arguments_ = parseArguments(values);
const pool = createPool(databaseUrl);
try {
  const budgets = new ModelBudgetRepository(pool);
  if (command === "set") {
    const userId = required(arguments_, "--user-id");
    const periodStart = instant(
      required(arguments_, "--period-start"),
      "--period-start",
    );
    const periodEnd = instant(
      required(arguments_, "--period-end"),
      "--period-end",
    );
    if (periodEnd <= periodStart) {
      throw new Error("--period-end must be after --period-start");
    }
    const limitAmountUsd = decimal(
      required(arguments_, "--limit-usd"),
      "--limit-usd",
    );
    await budgets.setLimit({
      id: randomUUID(),
      userId,
      limitAmountUsd,
      periodStart,
      periodEnd,
    });
    console.log(
      JSON.stringify({
        userId,
        limitAmountUsd,
        currency: "USD",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      }),
    );
  } else if (command === "ledger") {
    const rawLimit = arguments_["--limit"];
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    console.log(
      JSON.stringify(
        await budgets.listLedger({
          userId: required(arguments_, "--user-id"),
          limit,
        }),
      ),
    );
  } else {
    throw new Error("Use one command: set or ledger");
  }
} finally {
  await pool.end();
}
