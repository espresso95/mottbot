# LM Studio Memory Extraction Design

## Goal

Mottbot should feel like a long-running assistant that remembers durable facts, preferences, and active context across many Telegram conversations without hard-coding phrase detectors. Local memory extraction through LM Studio should continuously propose memory changes while the application remains the authority for validation, safety, deduplication, and prompt recall.

The design keeps the existing SQLite memory model:

- approved memories live in `session_memories`
- model proposals live in `memory_candidates`
- prompt construction injects only approved, unarchived scoped memory

## External API Assumptions

LM Studio exposes OpenAI-compatible local endpoints under a base URL such as `http://localhost:1234/v1`. The chat-completions endpoint is `POST /v1/chat/completions`, and structured output can be requested with `response_format.type="json_schema"`. LM Studio returns structured JSON as a string in `choices[0].message.content`, which the app must parse and validate.

References:

- https://lmstudio.ai/docs/developer/openai-compat
- https://lmstudio.ai/docs/developer/openai-compat/chat-completions
- https://lmstudio.ai/docs/developer/openai-compat/structured-output

## Non-Goals

- Do not replace `/remember`, `/memory`, or `/forget`.
- Do not let a model directly mutate memory without application validation.
- Do not hard-code many natural-language phrase patterns.
- Do not block normal chat if LM Studio is unavailable, slow, or returns malformed output.
- Do not store secrets, credentials, one-time codes, bearer tokens, API keys, or raw auth payloads.

## Memory Timing Modes

### Pre-Response Extraction

Runs after the user turn is persisted and before the main assistant prompt is built.

Use cases:

- assistant display-name preference: "your name is Jeff"
- durable style preference: "from now on be more concise"
- workflow preference: "for this repo, always use pnpm"

Requirements:

- configurable independently from post-response extraction
- short timeout, intended for local LM Studio latency
- can run against a single user transcript line
- accepted memories are available to the immediate assistant response
- failure logs a warning and the run continues without memory changes

### Async Post-Response Extraction

Runs after the assistant response is persisted.

Use cases:

- slower reflection over user and assistant turns
- extracting durable facts that do not need to affect the just-sent answer
- cleanup and duplicate candidate generation

Requirements:

- configurable independently from pre-response extraction
- can be awaited or scheduled asynchronously
- async mode must use its own timeout and not depend on the Telegram run abort signal
- failure logs a warning and does not alter the completed run

## Configuration

Proposed runtime config:

```json
{
  "memory": {
    "candidateExtractionEnabled": true,
    "extractionProvider": "lmstudio",
    "preResponseExtractionEnabled": true,
    "preResponseExtractionTimeoutMs": 1500,
    "postResponseExtractionEnabled": true,
    "postResponseExtractionAsync": true,
    "postResponseExtractionTimeoutMs": 10000,
    "candidateApprovalPolicy": "auto",
    "autoAcceptMaxSensitivity": "low",
    "lmStudio": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "model": "loaded-model-id",
      "timeoutMs": 5000,
      "maxTokens": 800,
      "temperature": 0
    }
  }
}
```

Compatibility defaults:

- `candidateExtractionEnabled=false`
- `extractionProvider="codex"` to preserve current behavior
- `preResponseExtractionEnabled=false`
- `postResponseExtractionEnabled=true`
- `postResponseExtractionAsync=false` to preserve current awaited post-run behavior unless opted in
- `candidateApprovalPolicy="pending"`
- `autoAcceptMaxSensitivity="low"`

## Provider Contract

The provider returns memory candidates, not raw writes:

```ts
type MemoryExtractionProvider = {
  extract(params: {
    prompt: MemoryCandidateExtractionPrompt;
    session: SessionRoute;
    signal: AbortSignal;
  }): Promise<{ rawText: string; provider: "codex" | "lmstudio" }>;
};
```

The shared application parser converts raw output into validated candidates:

- validates strict JSON
- normalizes scope
- resolves scope keys from the current session
- clamps text and reason length
- filters source message IDs to IDs present in the prompt
- classifies sensitivity from both model output and app-side heuristics
- dedupes candidates within one extraction response

## LM Studio Request

The LM Studio provider should call:

```text
POST {baseUrl}/chat/completions
```

Request shape:

```json
{
  "model": "loaded-model-id",
  "messages": [
    { "role": "system", "content": "You extract durable memory candidates..." },
    { "role": "user", "content": "Transcript..." }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "mottbot_memory_candidates",
      "strict": true,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "candidates": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "contentText": { "type": "string" },
                "reason": { "type": "string" },
                "scope": {
                  "type": "string",
                  "enum": ["session", "personal", "chat", "group", "project"]
                },
                "scopeKey": { "type": "string" },
                "sensitivity": {
                  "type": "string",
                  "enum": ["low", "medium", "high"]
                },
                "sourceMessageIds": {
                  "type": "array",
                  "items": { "type": "string" }
                }
              },
              "required": ["contentText", "reason", "scope", "scopeKey", "sensitivity", "sourceMessageIds"]
            }
          }
        },
        "required": ["candidates"]
      }
    }
  },
  "temperature": 0,
  "max_tokens": 800,
  "stream": false
}
```

The app should accept empty `scopeKey` for non-project scopes because scope keys are resolved from the active Telegram session.

## Applying Candidates

Candidate application should remain provider-independent:

1. Insert a pending candidate with `proposedBy` set to `model:<provider>:<phase>`.
2. If `candidateApprovalPolicy="auto"` and candidate sensitivity is at or below `autoAcceptMaxSensitivity`, accept it immediately.
3. Leave higher-sensitivity candidates pending for `/memory candidates`.
4. Log counts: parsed, inserted, accepted, pending, duplicate candidates, duplicate approved memories.

Immediate MVP keeps the current candidate text as the dedupe key. A later schema migration can add `category`, `memory_key`, and `confidence` for richer upsert semantics.

## Prompt Recall

Pre-response accepted memory is loaded through the existing prompt builder:

```text
Long-term memory approved for this chat:
- [chat] The assistant should answer to the name Jeff in this chat.
```

The default system prompt should continue to describe Mottbot as the runtime/product identity. Approved memory can define chat-facing preferences. This avoids making "Mottbot" and user-specific names conflict.

## Failure Behavior

LM Studio failures are non-fatal:

- connection refused
- request timeout
- non-2xx response
- missing `choices[0].message.content`
- malformed JSON
- schema-invalid candidate payload

Every failure logs provider, phase, session key, and error message. The chat run continues normally.

## Testing Plan

Unit tests:

- LM Studio provider sends `/chat/completions` request to configured base URL
- provider extracts `choices[0].message.content`
- provider errors clearly on non-2xx responses and missing content
- candidate prompt can be built with one transcript line for pre-response mode

Integration tests:

- pre-response LM Studio extraction stores and accepts a low-sensitivity memory before prompt building
- main model receives the newly accepted memory in prompt messages
- async post-response extraction is scheduled without delaying run completion
- malformed LM Studio JSON logs a warning and keeps the run completed
- existing Codex-backed post-response extraction still works

Operational tests:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage` after orchestration changes
- `corepack pnpm build`
- optional local manual test with LM Studio server running:
  - configure `memory.extractionProvider="lmstudio"`
  - configure `memory.preResponseExtractionEnabled=true`
  - send "your name is Jeff"
  - ask "what is your name?"
  - verify `/memory` shows the approved memory
