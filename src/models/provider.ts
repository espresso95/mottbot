import type { Message as ProviderMessage } from "@mariozechner/pi-ai";
import type { CodexResolvedAuth } from "../codex/types.js";
import type { TransportMode, CodexStreamResult } from "../codex/transport.js";
import type { CodexToolCall, CodexToolCallProgress } from "../codex/tool-calls.js";
import { supportsNativeImageInput } from "../codex/provider.js";
import type { PromptMessage } from "../runs/prompt-builder.js";
import type { ModelToolDeclaration } from "../tools/registry.js";

export type ModelResolvedAuth = CodexResolvedAuth;

export type ModelStreamParams = {
  sessionKey: string;
  modelRef: string;
  transport: TransportMode;
  auth: ModelResolvedAuth;
  systemPrompt?: string;
  messages: PromptMessage[];
  tools?: ModelToolDeclaration[];
  extraContextMessages?: ProviderMessage[];
  signal?: AbortSignal;
  fastMode?: boolean;
  onStart?: () => Promise<void> | void;
  onTextDelta?: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onToolCallStart?: (toolCall: CodexToolCallProgress) => Promise<void> | void;
  onToolCallEnd?: (toolCall: CodexToolCall) => Promise<void> | void;
};

export type ModelStreamResult = CodexStreamResult;

export type ModelTokenResolver = {
  resolve(profileId: string): Promise<ModelResolvedAuth>;
};

export type ModelTransport = {
  stream(params: ModelStreamParams): Promise<ModelStreamResult>;
};

export type ModelCapabilities = {
  supportsNativeImageInput(modelRef: string): boolean;
};

export const codexModelCapabilities: ModelCapabilities = {
  supportsNativeImageInput,
};
