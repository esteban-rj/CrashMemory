import { randomUUID } from "node:crypto";
import { createPool } from "../client.ts";
import { UserRepository } from "../repositories.ts";
import { hashPassword, normalizeEmail } from "@crashmemory/security";

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.SEED_EMAIL;
const password = process.env.SEED_PASSWORD;
const timeZone = process.env.SEED_TIME_ZONE ?? "America/Bogota";
if (!databaseUrl || !email || !password) {
  throw new Error("DATABASE_URL, SEED_EMAIL and SEED_PASSWORD are required");
}

const pool = createPool(databaseUrl);
try {
  const repository = new UserRepository(pool);
  const normalized = normalizeEmail(email);
  const existing = await repository.findByEmail(normalized);
  if (existing) {
    console.log(`Synthetic seed user already exists: ${existing.id}`);
  } else {
    const user = await repository.create({
      id: randomUUID(),
      emailNormalized: normalized,
      passwordHash: await hashPassword(password),
      timeZone,
    });
    console.log(`Created synthetic seed user: ${user.id}`);
  }
} finally {
  await pool.end();
}
