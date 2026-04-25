import { describe, expect, it } from "vitest";
import {
  buildMemoryCandidateAcceptCallbackData,
  buildMemoryCandidateArchiveCallbackData,
  buildMemoryCandidateRejectCallbackData,
  buildRunFilesCallbackData,
  buildRunNewCallbackData,
  buildRunRetryCallbackData,
  buildRunStopCallbackData,
  buildRunUsageCallbackData,
  buildToolApprovalCallbackData,
  buildToolDenyCallbackData,
  parseTelegramCallbackData,
} from "../../src/telegram/callback-data.js";

describe("Telegram callback data", () => {
  it("builds and parses approval callback payloads", () => {
    expect(parseTelegramCallbackData(buildToolApprovalCallbackData("audit-1"))).toEqual({
      type: "tool_approve",
      auditId: "audit-1",
    });
    expect(parseTelegramCallbackData(buildToolDenyCallbackData("audit-1"))).toEqual({
      type: "tool_deny",
      auditId: "audit-1",
    });
    expect(parseTelegramCallbackData(buildRunStopCallbackData("run-1"))).toEqual({
      type: "run_stop",
      runId: "run-1",
    });
    expect(parseTelegramCallbackData(buildRunRetryCallbackData("run-1"))).toEqual({
      type: "run_retry",
      runId: "run-1",
    });
    expect(parseTelegramCallbackData(buildRunNewCallbackData("run-1"))).toEqual({
      type: "run_new",
      runId: "run-1",
    });
    expect(parseTelegramCallbackData(buildRunUsageCallbackData("run-1"))).toEqual({
      type: "run_usage",
      runId: "run-1",
    });
    expect(parseTelegramCallbackData(buildRunFilesCallbackData("run-1"))).toEqual({
      type: "run_files",
      runId: "run-1",
    });
    expect(parseTelegramCallbackData(buildMemoryCandidateAcceptCallbackData("candidate-1"))).toEqual({
      type: "memory_accept",
      candidateId: "candidate-1",
    });
    expect(parseTelegramCallbackData(buildMemoryCandidateRejectCallbackData("candidate-1"))).toEqual({
      type: "memory_reject",
      candidateId: "candidate-1",
    });
    expect(parseTelegramCallbackData(buildMemoryCandidateArchiveCallbackData("candidate-1"))).toEqual({
      type: "memory_archive",
      candidateId: "candidate-1",
    });
  });

  it("ignores non-Mottbot or incomplete callback payloads", () => {
    expect(parseTelegramCallbackData("other:ta:audit-1")).toBeUndefined();
    expect(parseTelegramCallbackData("mb:unknown:audit-1")).toBeUndefined();
    expect(parseTelegramCallbackData("mb:ta:")).toBeUndefined();
  });

  it("rejects callback payloads above Telegram's data limit", () => {
    expect(() => buildToolApprovalCallbackData("x".repeat(80))).toThrow("Telegram callback data is too long.");
  });
});
