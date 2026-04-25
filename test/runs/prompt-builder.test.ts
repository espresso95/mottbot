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

  it("renders attachment metadata into user prompts", () => {
    const prompt = buildPrompt({
      history: [
        {
          id: "1",
          sessionKey: "s",
          role: "user",
          contentText: "See attached",
          contentJson: JSON.stringify({
            attachments: [
              {
                kind: "photo",
                fileId: "abc123",
                fileName: "/tmp/not-exposed.png",
                mimeType: "image/png",
                fileSize: 4096,
                width: 640,
                height: 480,
                ingestionStatus: "native_input",
                extraction: {
                  kind: "text",
                  status: "extracted",
                  promptChars: 20,
                  truncated: true,
                },
              },
            ],
          }),
          createdAt: 1,
        },
      ],
    });
    expect(prompt.messages[0]?.content).toContain("Attachments:");
    expect(prompt.messages[0]?.content).toContain("photo");
    expect(prompt.messages[0]?.content).toContain("not-exposed.png");
    expect(prompt.messages[0]?.content).toContain("image/png");
    expect(prompt.messages[0]?.content).toContain("640x480");
    expect(prompt.messages[0]?.content).toContain("native_input");
    expect(prompt.messages[0]?.content).toContain("extraction: text extracted");
    expect(prompt.messages[0]?.content).toContain("truncated");
    expect(prompt.messages[0]?.content).not.toContain("abc123");
    expect(prompt.messages[0]?.content).not.toContain("/tmp/");
  });

  it("compacts older history into a summary message", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1),
      sessionKey: "s",
      role: index % 2 === 0 ? "user" : "assistant",
      contentText: `message ${index + 1}`,
      createdAt: index + 1,
    })) as any;
    const prompt = buildPrompt({
      history,
      historyLimit: 4,
    });
    expect(prompt.messages[0]?.role).toBe("system");
    expect(prompt.messages[0]?.content).toContain("Earlier conversation summary:");
    expect(prompt.messages).toHaveLength(5);
  });

  it("adds long-term session memory as system context", () => {
    const prompt = buildPrompt({
      memories: [
        {
          id: "mem-1",
          sessionKey: "s",
          source: "explicit",
          scope: "session",
          scopeKey: "s",
          contentText: "User prefers concise implementation notes.",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      history: [{ id: "1", sessionKey: "s", role: "user", contentText: "hi", createdAt: 2 }],
    });

    expect(prompt.messages[0]).toEqual({
      role: "system",
      content: "Long-term memory approved for this chat:\n- [session] User prefers concise implementation notes.",
      timestamp: 1,
    });
    expect(prompt.messages[1]).toEqual({ role: "user", content: "hi", timestamp: 2 });
  });

  it("renders scoped pinned memory before automatic summaries", () => {
    const prompt = buildPrompt({
      memories: [
        {
          id: "auto",
          sessionKey: "s",
          source: "auto_summary",
          scope: "session",
          scopeKey: "s",
          contentText: "Automatic summary.",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "pin",
          sessionKey: "s",
          source: "model_candidate",
          scope: "personal",
          scopeKey: "user-1",
          contentText: "Pinned preference.",
          pinned: true,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      history: [{ id: "1", sessionKey: "s", role: "user", contentText: "hi", createdAt: 3 }],
    });

    expect(prompt.messages[0]?.content).toBe(
      [
        "Long-term memory approved for this chat:",
        "- [personal, pinned] Pinned preference.",
        "- [session, auto] Automatic summary.",
      ].join("\n"),
    );
  });
});
