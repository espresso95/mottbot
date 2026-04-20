import type { TransportMode } from "./transport.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_API = "openai-codex-responses";
export const KNOWN_CODEX_MODEL_REFS = [
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.3-codex-spark",
] as const;
export const KNOWN_CODEX_MODEL_REFS_TEXT = KNOWN_CODEX_MODEL_REFS.join(", ");

const CODEX_MODEL_REF_PATTERN = /^openai-codex\/[A-Za-z0-9._-]+$/;

export type CodexModelRef =
  | "openai-codex/gpt-5.4"
  | "openai-codex/gpt-5.4-mini"
  | "openai-codex/gpt-5.3-codex-spark"
  | (string & {});

export type RuntimeCodexModel = {
  id: string;
  name: string;
  api: typeof OPENAI_CODEX_API;
  provider: typeof OPENAI_CODEX_PROVIDER_ID;
  baseUrl: typeof OPENAI_CODEX_BASE_URL;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  contextTokens?: number;
  maxTokens: number;
  transport: TransportMode;
};

export function isKnownCodexModelRef(modelRef: string): modelRef is (typeof KNOWN_CODEX_MODEL_REFS)[number] {
  return (KNOWN_CODEX_MODEL_REFS as readonly string[]).includes(modelRef);
}

export function isCodexModelRef(modelRef: string): modelRef is CodexModelRef {
  return CODEX_MODEL_REF_PATTERN.test(modelRef);
}

export function supportsNativeImageInput(modelRef: string): boolean {
  return resolveCodexModel(modelRef, "sse").input.includes("image");
}

export function supportsNativeFileInput(_modelRef: string): boolean {
  return false;
}

export function resolveCodexModel(modelRef: string, transport: TransportMode): RuntimeCodexModel {
  if (!isCodexModelRef(modelRef)) {
    throw new Error(`Invalid Codex model ref ${modelRef}. Expected openai-codex/<model>.`);
  }
  const [, modelId = "gpt-5.4"] = modelRef.split("/");
  if (modelId === "gpt-5.4-mini") {
    return {
      id: modelId,
      name: modelId,
      api: OPENAI_CODEX_API,
      provider: OPENAI_CODEX_PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
      transport,
    };
  }
  if (modelId === "gpt-5.3-codex-spark") {
    return {
      id: modelId,
      name: modelId,
      api: OPENAI_CODEX_API,
      provider: OPENAI_CODEX_PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128_000,
      transport,
    };
  }
  return {
    id: modelId,
    name: modelId,
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER_ID,
    baseUrl: OPENAI_CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 1_050_000,
    contextTokens: 272_000,
    maxTokens: 128_000,
    transport,
  };
}
