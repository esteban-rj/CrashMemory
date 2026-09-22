import { createPool } from "@crashmemory/db";
import { S3ObjectStorage } from "@crashmemory/runtime";
import { LifecycleService } from "../index.ts";

const databaseUrl = process.env.DATABASE_URL;
const bucket = process.env.OBJECT_STORAGE_BUCKET;
if (!databaseUrl || !bucket)
  throw new Error("DATABASE_URL and OBJECT_STORAGE_BUCKET are required");
const limit = Number(process.env.LIFECYCLE_CLEANUP_LIMIT ?? "100");
const pool = createPool(databaseUrl, {
  application_name: "crashmemory-lifecycle-cleanup",
});
const storage = new S3ObjectStorage({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  bucket,
  accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
});
try {
  const result = await new LifecycleService(pool, storage).drainObjectCleanup(
    limit,
  );
  console.log(
    JSON.stringify({
      component: "lifecycle",
      event: "object_cleanup_retried",
      ...result,
    }),
  );
} finally {
  await pool.end();
}
