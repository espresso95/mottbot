import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMemoryCandidatesWithLmStudio } from "../../src/sessions/lmstudio-memory-extractor.js";
import type { MemoryCandidateExtractionPrompt } from "../../src/sessions/memory-candidates.js";

describe("extractMemoryCandidatesWithLmStudio", () => {
  const prompt: MemoryCandidateExtractionPrompt = {
    systemPrompt: "Extract memory.",
    messages: [{ role: "user", content: "Transcript", timestamp: 1 }],
    sourceMessageIds: ["m1"],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a structured chat completion request and returns message content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"candidates":[]}' } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const content = await extractMemoryCandidatesWithLmStudio({
      config: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "memory-model",
        timeoutMs: 2_000,
        maxTokens: 800,
        temperature: 0,
      },
      prompt,
      maxCandidates: 3,
    });

    expect(content).toBe('{"candidates":[]}');
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "memory-model",
      stream: false,
      temperature: 0,
      max_tokens: 800,
      response_format: { type: "json_schema" },
    });
    expect(body.messages).toEqual([
      { role: "system", content: "Extract memory." },
      { role: "user", content: "Transcript" },
    ]);
  });

  it("requires a configured LM Studio model", async () => {
    await expect(
      extractMemoryCandidatesWithLmStudio({
        config: {
          baseUrl: "http://127.0.0.1:1234/v1",
          timeoutMs: 2_000,
          maxTokens: 800,
          temperature: 0,
        },
        prompt,
        maxCandidates: 3,
      }),
    ).rejects.toThrow("memory.lmStudio.model is required");
  });

  it("surfaces non-2xx LM Studio responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "model is not loaded" } }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      extractMemoryCandidatesWithLmStudio({
        config: {
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "missing-model",
          timeoutMs: 2_000,
          maxTokens: 800,
          temperature: 0,
        },
        prompt,
        maxCandidates: 3,
      }),
    ).rejects.toThrow("model is not loaded");
  });
});
