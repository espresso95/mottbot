import type { RunStore } from "./run-store.js";

/** Persists provider usage metadata on completed run records. */
export class UsageRecorder {
  constructor(private readonly runs: RunStore) {}

  record(runId: string, usage: Record<string, unknown> | undefined): void {
    if (!usage) {
      return;
    }
    this.runs.update(runId, {
      usageJson: JSON.stringify(usage),
    });
  }
}
