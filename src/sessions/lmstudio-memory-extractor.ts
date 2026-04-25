import type { AppConfig } from "../app/config.js";
import { getErrorMessage } from "../shared/errors.js";
import type { MemoryCandidateExtractionPrompt } from "./memory-candidates.js";

type LmStudioMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type LmStudioChoice = {
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
};

type LmStudioChatCompletionResponse = {
  choices?: LmStudioChoice[];
  error?: {
    message?: unknown;
  };
};

type TimeoutSignal = {
  signal: AbortSignal;
  dispose: () => void;
};

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`LM Studio memory extraction timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  const abortFromParent = () => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function promptMessageContent(content: MemoryCandidateExtractionPrompt["messages"][number]["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function buildMessages(prompt: MemoryCandidateExtractionPrompt): LmStudioMessage[] {
  return [
    {
      role: "system",
      content: prompt.systemPrompt,
    },
    ...prompt.messages.map((message) => ({
      role: message.role,
      content: promptMessageContent(message.content),
    })),
  ];
}

function buildResponseFormat(maxCandidates: number): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "mottbot_memory_candidates",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidates: {
            type: "array",
            maxItems: maxCandidates,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                contentText: { type: "string" },
                reason: { type: "string" },
                scope: {
                  type: "string",
                  enum: ["session", "personal", "chat", "group", "project"],
                },
                scopeKey: { type: "string" },
                sensitivity: {
                  type: "string",
                  enum: ["low", "medium", "high"],
                },
                sourceMessageIds: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["contentText", "reason", "scope", "scopeKey", "sensitivity", "sourceMessageIds"],
            },
          },
        },
        required: ["candidates"],
      },
    },
  };
}

function completionEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function responseErrorMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === "object") {
    const message = (body as LmStudioChatCompletionResponse).error?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return `${status} ${statusText}`.trim();
}

function responseMessageContent(body: LmStudioChatCompletionResponse | undefined): string | undefined {
  const message = body?.choices?.[0]?.message;
  for (const value of [message?.content, message?.reasoning_content]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** Calls LM Studio's OpenAI-compatible chat completions API for memory candidate extraction. */
export async function extractMemoryCandidatesWithLmStudio(params: {
  config: AppConfig["memory"]["lmStudio"];
  prompt: MemoryCandidateExtractionPrompt;
  maxCandidates: number;
  signal?: AbortSignal;
}): Promise<string> {
  if (!params.config.model) {
    throw new Error("memory.lmStudio.model is required when memory.extractionProvider is 'lmstudio'.");
  }
  const timeoutSignal = createTimeoutSignal(params.signal, params.config.timeoutMs);
  try {
    const response = await fetch(completionEndpoint(params.config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: params.config.model,
        messages: buildMessages(params.prompt),
        response_format: buildResponseFormat(params.maxCandidates),
        temperature: params.config.temperature,
        max_tokens: params.config.maxTokens,
        stream: false,
      }),
      signal: timeoutSignal.signal,
    });
    const body = (await response.json().catch(async () => {
      const text = await response.text().catch(() => "");
      return text ? { error: { message: text.slice(0, 500) } } : undefined;
    })) as LmStudioChatCompletionResponse | undefined;
    if (!response.ok) {
      throw new Error(
        `LM Studio memory extraction failed: ${responseErrorMessage(response.status, response.statusText, body)}`,
      );
    }
    const content = responseMessageContent(body);
    if (!content) {
      throw new Error("LM Studio memory extraction returned no message content.");
    }
    return content;
  } catch (error) {
    if (timeoutSignal.signal.aborted) {
      throw new Error(getErrorMessage(timeoutSignal.signal.reason) || "LM Studio memory extraction was aborted.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    timeoutSignal.dispose();
  }
}
