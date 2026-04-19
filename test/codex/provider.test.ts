import { describe, expect, it } from "vitest";
import {
  OPENAI_CODEX_API,
  OPENAI_CODEX_BASE_URL,
  isKnownCodexModelRef,
  resolveCodexModel,
  supportsNativeImageInput,
} from "../../src/codex/provider.js";

describe("resolveCodexModel", () => {
  it("builds gpt-5.4 defaults", () => {
    const model = resolveCodexModel("openai-codex/gpt-5.4", "auto");
    expect(model.api).toBe(OPENAI_CODEX_API);
    expect(model.baseUrl).toBe(OPENAI_CODEX_BASE_URL);
    expect(model.contextTokens).toBe(272_000);
  });

  it("builds spark defaults", () => {
    const model = resolveCodexModel("openai-codex/gpt-5.3-codex-spark", "sse");
    expect(model.transport).toBe("sse");
    expect(model.input).toEqual(["text"]);
    expect(model.maxTokens).toBe(128_000);
  });

  it("identifies supported command-selectable model refs", () => {
    expect(isKnownCodexModelRef("openai-codex/gpt-5.4-mini")).toBe(true);
    expect(isKnownCodexModelRef("openai-codex/not-a-model")).toBe(false);
  });

  it("identifies native image input support", () => {
    expect(supportsNativeImageInput("openai-codex/gpt-5.4")).toBe(true);
    expect(supportsNativeImageInput("openai-codex/gpt-5.3-codex-spark")).toBe(false);
  });
});
