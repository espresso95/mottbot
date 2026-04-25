import { describe, expect, it, vi } from "vitest";
import { scheduleServiceRestart } from "../../src/tools/process-control.js";

describe("scheduleServiceRestart", () => {
  it("schedules a delayed launchd restart command on macOS", () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }) as never);

    const result = scheduleServiceRestart(
      {
        reason: "planned restart",
        delayMs: 12_300,
        projectRoot: "/tmp/mottbot test",
      },
      {
        platform: "darwin",
        execPath: "/usr/local/bin/node",
        spawn,
      },
    );

    expect(result).toEqual({
      scheduled: true,
      delayMs: 13_000,
      reason: "planned restart",
    });
    expect(spawn).toHaveBeenCalledWith("/bin/zsh", ["-lc", expect.stringContaining("sleep 13")], {
      detached: true,
      stdio: "ignore",
    });
    expect(spawn.mock.calls[0]?.[1]?.[1]).toContain("service restart");
    expect(spawn.mock.calls[0]?.[1]?.[1]).toContain("'/tmp/mottbot test'");
    expect(unref).toHaveBeenCalled();
  });

  it("rejects unsupported platforms", () => {
    expect(() =>
      scheduleServiceRestart(
        {
          reason: "planned restart",
          delayMs: 1_000,
        },
        {
          platform: "linux",
        },
      ),
    ).toThrow("macOS launchd only");
  });
});
