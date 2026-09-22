import { createPool } from "@crashmemory/db";
import { S3ObjectStorage } from "@crashmemory/runtime";
import { LifecycleBackupService } from "../backup.ts";

if (process.env.LIFECYCLE_QUIESCED !== "true")
  throw new Error(
    "LIFECYCLE_QUIESCED=true is required; restore only into a migrated empty database and bucket",
  );
const required = [
  "DATABASE_URL",
  "LIFECYCLE_BACKUP_INPUT",
  "LIFECYCLE_BACKUP_KEY_BASE64",
  "LIFECYCLE_JOURNAL_PATH",
  "LIFECYCLE_JOURNAL_KEY_BASE64",
  "OBJECT_STORAGE_BUCKET",
] as const;
for (const name of required)
  if (!process.env[name]) throw new Error(`${name} is required`);
const pool = createPool(process.env.DATABASE_URL!);
const storage = new S3ObjectStorage({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  bucket: process.env.OBJECT_STORAGE_BUCKET!,
  accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
});
try {
  await storage.ensureBucket();
  const result = await new LifecycleBackupService(pool, storage).restore({
    databaseUrl: process.env.DATABASE_URL!,
    archivePath: process.env.LIFECYCLE_BACKUP_INPUT!,
    encryptionKeyBase64: process.env.LIFECYCLE_BACKUP_KEY_BASE64!,
    journalPath: process.env.LIFECYCLE_JOURNAL_PATH!,
    journalKeyBase64: process.env.LIFECYCLE_JOURNAL_KEY_BASE64!,
  });
  console.log(
    JSON.stringify({
      component: "lifecycle",
      event: "restore_completed",
      ...result,
    }),
  );
} finally {
  await pool.end();
}
