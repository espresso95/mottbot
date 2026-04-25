import { describe, expect, it } from "vitest";
import {
  buildProjectApprovalCallbackData,
  buildToolApprovalCallbackData,
  parseTelegramCallbackData,
} from "../../src/telegram/callback-data.js";

describe("Telegram callback data", () => {
  it("builds and parses approval callback payloads", () => {
    expect(parseTelegramCallbackData(buildToolApprovalCallbackData("audit-1"))).toEqual({
      type: "tool_approve",
      auditId: "audit-1",
    });
    expect(parseTelegramCallbackData(buildProjectApprovalCallbackData("approval-1"))).toEqual({
      type: "project_approve",
      approvalId: "approval-1",
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
