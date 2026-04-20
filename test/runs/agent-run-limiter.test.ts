import { describe, expect, it } from "vitest";
import { AgentRunLimiter } from "../../src/runs/agent-run-limiter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("AgentRunLimiter", () => {
  it("limits concurrent runs per agent without blocking other agents", async () => {
    const limiter = new AgentRunLimiter();
    const firstRelease = deferred<void>();
    const events: string[] = [];

    const first = limiter.run("docs", 1, async () => {
      events.push("docs:first:start");
      await firstRelease.promise;
      events.push("docs:first:end");
      return "first";
    });
    const second = limiter.run("docs", 1, async () => {
      events.push("docs:second:start");
      return "second";
    });
    const other = limiter.run("ops", 1, async () => {
      events.push("ops:first:start");
      return "other";
    });

    await expect(other).resolves.toBe("other");
    expect(events).toEqual(["docs:first:start", "ops:first:start"]);

    firstRelease.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual([
      "docs:first:start",
      "ops:first:start",
      "docs:first:end",
      "docs:second:start",
    ]);
  });
});
