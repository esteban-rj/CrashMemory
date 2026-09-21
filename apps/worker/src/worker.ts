import { CONTRACT_VERSION } from "@crashmemory/contracts";

console.log(
  `CrashMemory worker skeleton ready for outbox events (${CONTRACT_VERSION}).`,
);
console.log("V03 adds durable consumption, idempotency and recovery.");
