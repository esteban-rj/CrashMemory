import { buildApp } from "./app.ts";

const app = buildApp();
const port = Number(process.env.API_PORT ?? 4310);

try {
  await app.listen({ host: "127.0.0.1", port });
  console.log(
    `CrashMemory synthetic demo API listening on http://127.0.0.1:${port}`,
  );
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
