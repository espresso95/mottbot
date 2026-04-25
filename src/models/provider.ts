import type { Message as ProviderMessage } from "@mariozechner/pi-ai";
import type { CodexResolvedAuth } from "../codex/types.js";
import type { TransportMode, CodexStreamResult } from "../codex/transport.js";
import type { CodexToolCall, CodexToolCallProgress } from "../codex/tool-calls.js";
import { supportsNativeFileInput, supportsNativeImageInput } from "../codex/provider.js";
import type { PromptMessage } from "../runs/prompt-builder.js";
import type { ModelToolDeclaration } from "../tools/registry.js";

/** Auth shape exposed to the model abstraction layer. */
export type ModelResolvedAuth = CodexResolvedAuth;

/** Provider-neutral stream request used by run orchestration. */
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

/** Provider-neutral stream result returned to run orchestration. */
export type ModelStreamResult = CodexStreamResult;

/** Resolves model-provider credentials for a configured auth profile. */
export type ModelTokenResolver = {
  resolve(profileId: string): Promise<ModelResolvedAuth>;
};

/** Streams one model request through the selected provider transport. */
export type ModelTransport = {
  stream(params: ModelStreamParams): Promise<ModelStreamResult>;
};

/** Capability predicates used before sending native attachments to a provider. */
export type ModelCapabilities = {
  supportsNativeImageInput(modelRef: string): boolean;
  supportsNativeFileInput(modelRef: string): boolean;
};

/** Codex provider capability predicates wired into the model abstraction. */
export const codexModelCapabilities: ModelCapabilities = {
  supportsNativeFileInput,
  supportsNativeImageInput,
};
