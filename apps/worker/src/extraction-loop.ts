export interface ExtractionLoopDependencies {
  recoverExpired(): Promise<number>;
  runOne(): Promise<unknown>;
  report(event: "extraction_tick_failed", code: string): void;
}

/** Serializes durable extraction ticks and drains an active tick at shutdown. */
export class ExtractionLoop {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly dependencies: ExtractionLoopDependencies,
    private readonly intervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    if (!this.stopping)
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async tick(): Promise<void> {
    if (this.stopping || this.active) return;
    const work = this.runTick();
    this.active = work;
    try {
      await work;
    } finally {
      if (this.active === work) this.active = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  private async runTick(): Promise<void> {
    try {
      await this.dependencies.recoverExpired();
      await this.dependencies.runOne();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : error instanceof Error
            ? error.name
            : "runtime_error";
      this.dependencies.report("extraction_tick_failed", code);
    }
  }
}
