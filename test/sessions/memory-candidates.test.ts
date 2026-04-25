import { describe, expect, it } from "vitest";
import {
  buildMemoryCandidateExtractionPrompt,
  classifyMemorySensitivity,
  parseMemoryCandidateResponse,
} from "../../src/sessions/memory-candidates.js";

const context = {
  sessionKey: "tg:dm:chat-1:user:user-1",
  chatId: "chat-1",
  userId: "user-1",
  routeMode: "dm" as const,
};

describe("memory candidate extraction", () => {
  it("parses model JSON, resolves scopes, filters source ids, and deduplicates candidates", () => {
    const candidates = parseMemoryCandidateResponse({
      raw: JSON.stringify({
        candidates: [
          {
            contentText: "User prefers concise updates.",
            reason: "The user asked for terse implementation status.",
            scope: "personal",
            sensitivity: "low",
            sourceMessageIds: ["m1", "unknown"],
          },
          {
            memory: "User prefers concise updates.",
            scope: "personal",
            sensitivity: "low",
            sourceMessageIds: ["m2"],
          },
          {
            content: "Project uses pnpm.",
            scope: "project",
            scopeKey: "mottbot",
            sensitivity: "low",
            sourceMessageIds: ["m2"],
          },
        ],
      }),
      context,
      allowedSourceMessageIds: ["m1", "m2"],
    });

    expect(candidates).toEqual([
      {
        scope: "personal",
        scopeKey: "user-1",
        contentText: "User prefers concise updates.",
        reason: "The user asked for terse implementation status.",
        sourceMessageIds: ["m1"],
        sensitivity: "low",
      },
      {
        scope: "project",
        scopeKey: "mottbot",
        contentText: "Project uses pnpm.",
        sourceMessageIds: ["m2"],
        sensitivity: "low",
      },
    ]);
  });

  it("rejects malformed candidate payloads and upgrades secret-like sensitivity", () => {
    expect(() =>
      parseMemoryCandidateResponse({
        raw: "not json",
        context,
        allowedSourceMessageIds: [],
      }),
    ).toThrow();

    expect(classifyMemorySensitivity("The bot token is 123456:abcdefghijklmnopqrstuvwxyz")).toBe("high");
    expect(
      parseMemoryCandidateResponse({
        raw: JSON.stringify({
          candidates: [
            {
              contentText: "The bot token is 123456:abcdefghijklmnopqrstuvwxyz",
              scope: "session",
              sensitivity: "low",
            },
          ],
        }),
        context,
        allowedSourceMessageIds: [],
      })[0]?.sensitivity,
    ).toBe("high");
  });

  it("parses fenced array output and skips unresolved scopes", () => {
    const candidates = parseMemoryCandidateResponse({
      raw: [
        "```json",
        JSON.stringify([
          { contentText: "Chat prefers summaries.", scope: "chat", sensitivity: "low" },
          { contentText: "Group-only fact.", scope: "group", sensitivity: "low" },
        ]),
        "```",
      ].join("\n"),
      context,
      allowedSourceMessageIds: [],
    });

    expect(candidates).toEqual([
      {
        scope: "chat",
        scopeKey: "chat-1",
        contentText: "Chat prefers summaries.",
        sourceMessageIds: [],
        sensitivity: "low",
      },
    ]);
  });

  it("builds a bounded extraction prompt with transcript source ids", () => {
    const prompt = buildMemoryCandidateExtractionPrompt({
      maxCandidates: 3,
      messages: [
        { id: "m1", sessionKey: "s", role: "user", contentText: "remember that I use pnpm", createdAt: 1 },
        { id: "m2", sessionKey: "s", role: "assistant", contentText: "Noted.", createdAt: 2 },
      ],
    });

    expect(prompt?.sourceMessageIds).toEqual(["m1", "m2"]);
    expect(prompt?.systemPrompt).toContain("Return strict JSON only");
    expect(prompt?.systemPrompt).toContain("assistant identity preferences");
    expect(prompt?.messages[0]?.content).toContain("Your name is Jeff");
    expect(prompt?.messages[0]?.content).toContain("[m1] user");
  });

  it("does not build a prompt without enough visible transcript lines", () => {
    expect(
      buildMemoryCandidateExtractionPrompt({
        maxCandidates: 3,
        messages: [
          { id: "m1", sessionKey: "s", role: "tool", contentText: "tool output", createdAt: 1 },
          { id: "m2", sessionKey: "s", role: "assistant", contentText: "", createdAt: 2 },
        ],
      }),
    ).toBeUndefined();
  });
});
