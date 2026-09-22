import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";

if (process.argv.length < 3) {
  console.error("Usage: node scripts/run-local.mjs <pnpm arguments>");
  process.exit(2);
}

loadEnvFile(".env");
const child = spawn("pnpm", process.argv.slice(2), {
  detached: true,
  env: process.env,
  stdio: "inherit",
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping || child.pid === undefined) return;
    stopping = true;
    process.kill(-child.pid, signal);
  });
}
child.on("error", (error) => {
  console.error(`Cannot start pnpm: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
