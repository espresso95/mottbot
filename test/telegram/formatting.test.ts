import { describe, expect, it } from "vitest";
import { normalizeTelegramText, splitTelegramText } from "../../src/telegram/formatting.js";

describe("telegram formatting", () => {
  it("normalizes null bytes and trim", () => {
    expect(normalizeTelegramText(" \u0000hello \n")).toBe("hello");
  });

  it("splits long text on natural boundaries", () => {
    const text = `${"a".repeat(100)}\n\n${"b".repeat(100)} ${"c".repeat(100)}`;
    const chunks = splitTelegramText(text, 130);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("aaaa");
    expect(chunks.join("")).toContain("bbbb");
  });
});
