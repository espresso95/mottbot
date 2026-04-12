import { describe, expect, it } from "vitest";
import { SessionQueue } from "../../src/sessions/queue.js";

describe("SessionQueue", () => {
  it("serializes tasks per session", async () => {
    const queue = new SessionQueue();
    const order: string[] = [];
    await Promise.all([
      queue.enqueue("session-1", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a-end");
      }),
      queue.enqueue("session-1", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("cancels an active task", async () => {
    const queue = new SessionQueue();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const promise = queue.enqueue("session-2", async (signal) => {
      startedResolve?.();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const rejected = expect(promise).rejects.toBeTruthy();
    await started;
    expect(queue.cancel("session-2")).toBe(true);
    await rejected;
  });
});
