import Fastify from "fastify";
import { CONTRACT_VERSION, demoObligation } from "@crashmemory/contracts";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({
    status: "ok",
    mode: process.env.APP_ENV ?? "demo",
  }));
  app.get("/api/v1/contracts", async () => ({ version: CONTRACT_VERSION }));
  app.get("/api/v1/demo/obligations", async () => ({
    data: [demoObligation],
    meta: { mode: "synthetic-demo", persistence: "none" },
  }));

  return app;
}
