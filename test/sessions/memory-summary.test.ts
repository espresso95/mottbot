import { describe, expect, it } from "vitest";
import { buildAutomaticMemorySummary } from "../../src/sessions/memory-summary.js";

describe("automatic memory summaries", () => {
  it("skips medium and high sensitivity turns before persisting summaries", () => {
    const summary = buildAutomaticMemorySummary({
      maxChars: 500,
      messages: [
        {
          id: "m1",
          sessionKey: "s",
          role: "user",
          contentText: "Use pnpm for checks.",
          createdAt: 1,
        },
        {
          id: "m2",
          sessionKey: "s",
          role: "assistant",
          contentText: "Got it.",
          createdAt: 2,
        },
        {
          id: "m3",
          sessionKey: "s",
          role: "user",
          contentText: "My token is 123456:abcdefghijklmnopqrstuvwxyz.",
          createdAt: 3,
        },
        {
          id: "m4",
          sessionKey: "s",
          role: "user",
          contentText: "My email is user@example.com.",
          createdAt: 4,
        },
      ],
    });

    expect(summary).toContain("Use pnpm for checks.");
    expect(summary).toContain("Got it.");
    expect(summary).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
    expect(summary).not.toContain("user@example.com");
  });
});
