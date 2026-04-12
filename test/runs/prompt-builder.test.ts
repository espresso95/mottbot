import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../src/runs/prompt-builder.js";

describe("buildPrompt", () => {
  it("keeps user/assistant/system messages and drops tool messages", () => {
    const prompt = buildPrompt({
      history: [
        { id: "1", sessionKey: "s", role: "user", contentText: "hi", createdAt: 1 },
        { id: "2", sessionKey: "s", role: "assistant", contentText: "hello", createdAt: 2 },
        { id: "3", sessionKey: "s", role: "tool", contentText: "ignored", createdAt: 3 },
        { id: "4", sessionKey: "s", role: "system", contentText: "rules", createdAt: 4 },
      ],
      systemPrompt: "custom",
    });
    expect(prompt.systemPrompt).toBe("custom");
    expect(prompt.messages).toEqual([
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
      { role: "system", content: "rules", timestamp: 4 },
    ]);
  });
});
