import { existsSync, readdirSync } from "node:fs";

const required = [
  "README.md",
  "docs/contracts/canonical-model-v1.md",
  "docs/contracts/http-v1.md",
  "docs/contracts/events-v1.md",
  "docs/contracts/erd-v1.md",
  "apps/api/src/server.ts",
  "apps/web/app/page.tsx",
  "apps/worker/src/worker.ts",
  "apps/scheduler/src/scheduler.ts",
  "packages/contracts/src/index.ts",
];

const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  throw new Error(`Foundation files missing: ${missing.join(", ")}`);
}

for (const directory of ["apps", "packages"]) {
  if (readdirSync(directory).length === 0) {
    throw new Error(`${directory} must contain workspace packages.`);
  }
}

console.log("Workspace structure is complete.");
