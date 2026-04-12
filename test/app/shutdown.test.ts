import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdown } from "../../src/app/shutdown.js";
import { createLogger } from "../../src/shared/logger.js";

describe("installShutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers signal handlers and invokes shutdown once", async () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as any);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const onShutdown = vi.fn(async () => undefined);

    installShutdown({
      logger: createLogger("silent"),
      onShutdown,
    });

    handlers.get("SIGINT")?.();
    await Promise.resolve();
    handlers.get("SIGTERM")?.();
    await Promise.resolve();

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
