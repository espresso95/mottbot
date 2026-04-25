import { describe, expect, it } from "vitest";
import {
  RUN_STATUS_TEXT,
  formatRunFailedStatus,
  formatToolCompletedStatus,
  formatToolPreparingStatus,
  formatToolRunningStatus,
  isTransientRunStatus,
} from "../../src/shared/run-status.js";

describe("run status text", () => {
  it("formats stable run and tool status messages", () => {
    expect(RUN_STATUS_TEXT.starting).toBe("Starting run...");
    expect(RUN_STATUS_TEXT.resumingAfterRestart).toBe("Resuming queued run after restart...");
    expect(RUN_STATUS_TEXT.unableToResumeAfterRestart).toBe("Unable to resume queued run after restart.");
    expect(formatToolPreparingStatus("mottbot_health_snapshot")).toBe("Preparing tool: mottbot_health_snapshot...");
    expect(formatToolRunningStatus("mottbot_health_snapshot")).toBe("Running tool: mottbot_health_snapshot...");
    expect(formatToolCompletedStatus({ toolName: "mottbot_health_snapshot", isError: false })).toBe(
      "Tool mottbot_health_snapshot completed. Continuing...",
    );
    expect(formatToolCompletedStatus({ toolName: "mottbot_shell", isError: true })).toBe(
      "Tool mottbot_shell failed. Continuing...",
    );
    expect(formatRunFailedStatus("boom")).toBe("Run failed: boom");
  });

  it("recognizes current and legacy transient run statuses", () => {
    expect(isTransientRunStatus(RUN_STATUS_TEXT.starting)).toBe(true);
    expect(isTransientRunStatus(RUN_STATUS_TEXT.resumingAfterRestart)).toBe(true);
    expect(isTransientRunStatus(RUN_STATUS_TEXT.unableToResumeAfterRestart)).toBe(true);
    expect(isTransientRunStatus("Working...")).toBe(true);
    expect(isTransientRunStatus("Resuming queued request after restart...")).toBe(true);
    expect(isTransientRunStatus("Unable to resume queued request after restart.")).toBe(true);
    expect(isTransientRunStatus(formatToolPreparingStatus("mottbot_health_snapshot"))).toBe(true);
    expect(isTransientRunStatus(formatToolRunningStatus("mottbot_health_snapshot"))).toBe(true);
    expect(isTransientRunStatus(formatToolCompletedStatus({ toolName: "mottbot_shell", isError: true }))).toBe(true);
    expect(isTransientRunStatus("Partial assistant text")).toBe(false);
    expect(isTransientRunStatus(formatRunFailedStatus("boom"))).toBe(false);
  });
});
