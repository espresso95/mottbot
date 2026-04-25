import { describe, expect, it, vi } from "vitest";
import type { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import { createOperatorDiagnosticToolHandlers } from "../../src/tools/operator-diagnostic-handlers.js";
import type { ToolExecutionContext } from "../../src/tools/executor.js";

function createContext(input: Record<string, unknown>): ToolExecutionContext {
  return {
    definition: {} as never,
    arguments: input,
  };
}

describe("createOperatorDiagnosticToolHandlers", () => {
  it("normalizes optional diagnostic arguments before calling runtime services", async () => {
    const diagnostics = {
      serviceStatus: vi.fn(() => "service ok"),
      recentRuns: vi.fn(() => [{ runId: "run-1" }]),
      recentErrorsText: vi.fn(() => "recent errors"),
      recentLogsText: vi.fn(() => "recent logs"),
    } as unknown as OperatorDiagnostics;
    const handlers = createOperatorDiagnosticToolHandlers(diagnostics);

    await expect(Promise.resolve(handlers.mottbot_service_status?.(createContext({})))).resolves.toBe("service ok");

    await expect(
      Promise.resolve(handlers.mottbot_recent_runs?.(createContext({ limit: 5, sessionKey: "  tg:dm:chat:user  " }))),
    ).resolves.toEqual([{ runId: "run-1" }]);
    expect(diagnostics.recentRuns).toHaveBeenLastCalledWith({
      limit: 5,
      sessionKey: "tg:dm:chat:user",
    });

    await handlers.mottbot_recent_runs?.(createContext({ limit: 1.5, sessionKey: "   " }));
    expect(diagnostics.recentRuns).toHaveBeenLastCalledWith({
      limit: undefined,
      sessionKey: undefined,
    });

    await expect(Promise.resolve(handlers.mottbot_recent_errors?.(createContext({ limit: 10 })))).resolves.toBe(
      "recent errors",
    );
    expect(diagnostics.recentErrorsText).toHaveBeenLastCalledWith(10);

    await handlers.mottbot_recent_errors?.(createContext({ limit: "10" }));
    expect(diagnostics.recentErrorsText).toHaveBeenLastCalledWith(undefined);

    await expect(
      Promise.resolve(handlers.mottbot_recent_logs?.(createContext({ stream: "stderr", lines: 25 }))),
    ).resolves.toBe("recent logs");
    expect(diagnostics.recentLogsText).toHaveBeenLastCalledWith({
      stream: "stderr",
      lines: 25,
    });

    await handlers.mottbot_recent_logs?.(createContext({ stream: "combined", lines: 4.2 }));
    expect(diagnostics.recentLogsText).toHaveBeenLastCalledWith({
      stream: undefined,
      lines: undefined,
    });
  });
});
