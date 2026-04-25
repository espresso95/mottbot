# Codex Subscription Provider

## Purpose

This repo intentionally separates the subscription-backed Codex integration from the rest of the Telegram bot. The goal is to keep the provider boundary narrow:

- dedicated provider ID: `openai-codex`
- local OAuth login or Codex CLI auth reuse
- model traffic sent to the Codex backend path
- runtime execution delegated to `@mariozechner/pi-ai`

This is not the normal OpenAI API key path.

## Provider Identity

Current provider constants:

```ts
OPENAI_CODEX_PROVIDER_ID = "openai-codex";
OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
OPENAI_CODEX_API = "openai-codex-responses";
```

Current built-in model refs:

- `openai-codex/gpt-5.4`: text and image input
- `openai-codex/gpt-5.4-mini`: text and image input
- `openai-codex/gpt-5.3-codex-spark`: text input

The `/model` command only accepts these built-in refs. File or environment configuration may still use an advanced `openai-codex/<model>` override for operator testing, but refs for other providers are rejected at the Codex provider boundary.

The provider catalog also records:

- whether the model supports reasoning
- supported input modalities
- pricing metadata
- context window metadata
- current transport mode

## Why The Provider Is Isolated

Only `src/codex/*` knows about:

- ChatGPT/Codex OAuth
- the Codex CLI `auth.json` format
- OAuth-to-runtime API key conversion
- the `chatgpt.com/backend-api` base URL
- the `/wham/usage` endpoint

Every other subsystem works in terms of:

- profile IDs
- model refs
- resolved auth objects
- transport streams

That keeps the rest of the app stable if the provider changes later.

## Auth Profile Model

Auth profiles are persisted in the `auth_profiles` table and loaded through `AuthProfileStore`.

### Stored fields

- `profile_id`
- `provider`
- `source`
- encrypted access token
- encrypted refresh token
- `expires_at`
- `account_id`
- `email`
- `display_name`
- `metadata_json`
- timestamps

### Auth sources

- `local_oauth`
- `codex_cli`

Sensitive values are encrypted at rest using AES-256-GCM via `SecretBox`.

## Local OAuth Flow

The host-local login path is implemented in `runCodexOAuthLogin()`.

### Flow

1. Load `@mariozechner/pi-ai/oauth`.
2. Call `loginOpenAICodex()`.
3. Normalize the authorize URL to ensure these scopes are present:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `model.request`
   - `api.responses.write`
4. Open the browser and also print the URL to stdout.
5. Accept interactive prompts and manual code or redirect URL fallback.
6. Persist the returned credentials into the selected auth profile.

### Stored metadata

The stored profile metadata includes:

- `source = loginOpenAICodex`
- configured callback host
- configured callback port

The current implementation relies on Pi AI to handle the underlying PKCE and token exchange details.

## Codex CLI Auth Reuse

The CLI reuse path is implemented in `cli-auth-import.ts`.

### Lookup behavior

The app reads:

- `$CODEX_HOME/auth.json`
- or `~/.codex/auth.json` when `CODEX_HOME` is not set

### Import rules

- `auth_mode` must be `chatgpt`
- both `access_token` and `refresh_token` must be present
- account ID is imported when available
- identity is decoded from the JWT payload when possible

### Imported profile semantics

Imported profiles are stored in the local database, but they are treated as externally managed credentials:

- source is recorded as `codex_cli`
- metadata records the Codex home path and import time
- on each resolution, the app re-reads the CLI auth file before using cached values

## Token Resolution

`CodexTokenResolver` is the runtime entry point for auth.

### Resolution rules

1. Load the profile from the database.
2. If the profile is `codex_cli`, re-import the current CLI auth state first.
3. If the access token is fresh enough, use it directly.
4. If the token is near expiry and no refresh token is available, fail with a clear profile error.
5. If the token is near expiry and a refresh token exists, refresh it under a per-profile mutex.
6. Convert OAuth credentials into a runtime API key via `getOAuthApiKey()` when the provider supports it.

### Refresh locking

Refresh is guarded by an in-memory `Map<profileId, Promise<...>>`.

This prevents two concurrent runs from refreshing the same profile at the same time.

### Refresh write-back

If a `codex_cli` profile is refreshed:

- the app attempts to write the refreshed token set back to the Codex CLI `auth.json`
- if write-back succeeds, it re-imports the profile from that file
- if write-back fails, it keeps the refreshed encrypted database profile and logs a token-free warning

That keeps CLI-backed credentials authoritative when possible without reverting the runtime profile to stale credentials after a local file permission failure.

## Transport Layer

`CodexTransport` wraps Pi AI model execution and makes it Telegram-friendly.

### Input contract

The transport accepts:

- `sessionKey`
- `modelRef`
- `transport` mode: `auto`, `websocket`, or `sse`
- resolved auth
- system prompt
- message history
- optional abort signal
- optional `fastMode`
- stream callbacks

### Streaming behavior

In `auto` mode:

1. prefer WebSocket
2. if an early WebSocket-style failure occurs before progress is emitted, retry as SSE
3. mark the session as degraded to SSE for 60 seconds
4. keep using SSE during the degraded window

The degradation cache is stored in the `transport_state` table.

### Payload shaping

Before sending the request:

- if `fastMode` is enabled, `service_tier` defaults to `priority`
- text verbosity defaults to `medium` unless already provided
- the current request shape uses text blocks and image blocks; generic file, PDF, audio, and video blocks are not emitted because the local Pi AI provider surface does not document those input block types

### Stream event handling

Supported Pi AI stream event types used by the transport:

- `start`
- `text_start`
- `text_delta`
- `thinking_delta`
- `done`
- `error`

If Pi AI returns a non-streaming result instead of an async iterable, the transport falls back to `completeSimple()`.

Current behavior:

- `onStart` is guaranteed to fire even for non-streaming completions
- transport fallback is intentionally disabled once any stream progress has been emitted, to avoid duplicated output

## Usage Fetch

The status command queries usage through:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

Headers:

- `Authorization: Bearer <access_token>`
- `ChatGPT-Account-Id: <account_id>` when known
- `User-Agent: Mottbot`

The response is normalized into:

- provider display name
- optional plan description
- one or more labeled usage windows such as `3h`, `Day`, or `Week`
- optional reset timestamps for usage windows

The Telegram `/status` command includes plan and reset details when present. If usage lookup fails or times out, `/status` still responds with `Usage unavailable` and does not expose account IDs or auth material.

## Security Model

At rest:

- access and refresh tokens are encrypted with a key derived from `MOTTBOT_MASTER_KEY`

In process:

- the token resolver only exposes the data required for a run
- logs use structured messages and do not intentionally emit raw tokens

Operational assumption:

- the host running this bot is trusted by the operator

## Caveats

This provider path is intentionally isolated because it is not the normal public API integration path.

Operational implications:

- it depends on ChatGPT/Codex subscription-backed credentials
- it relies on `@mariozechner/pi-ai` for undocumented provider-specific mechanics
- backend behavior may change independently of the standard OpenAI API

This is why the provider boundary is intentionally isolated from the rest of the bot.
