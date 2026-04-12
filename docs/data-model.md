# Data Model

## Configuration Model

Configuration comes from three layers:

1. defaults baked into `config.ts`
2. `mottbot.config.json`
3. environment variables, which take precedence

## Required Secrets

- `TELEGRAM_BOT_TOKEN` or the env var named by `telegram.botTokenEnv`
- `MOTTBOT_MASTER_KEY`

## Useful Environment Variables

- `MOTTBOT_CONFIG_PATH`
- `MOTTBOT_ADMIN_USER_IDS`
- `MOTTBOT_ALLOWED_CHAT_IDS`
- `MOTTBOT_TELEGRAM_POLLING`
- `MOTTBOT_DEFAULT_MODEL`
- `MOTTBOT_TRANSPORT`
- `MOTTBOT_DEFAULT_PROFILE`
- `MOTTBOT_PREFER_CLI_IMPORT`
- `MOTTBOT_SQLITE_PATH`
- `MOTTBOT_GROUP_MENTION_ONLY`
- `MOTTBOT_EDIT_THROTTLE_MS`
- `MOTTBOT_LOG_LEVEL`
- `MOTTBOT_OAUTH_CALLBACK_HOST`
- `MOTTBOT_OAUTH_CALLBACK_PORT`
- `CODEX_HOME`

## Default Runtime Settings

Current defaults:

```json
{
  "telegram": {
    "botTokenEnv": "TELEGRAM_BOT_TOKEN",
    "polling": true,
    "adminUserIds": [],
    "allowedChatIds": []
  },
  "models": {
    "default": "openai-codex/gpt-5.4",
    "transport": "auto"
  },
  "auth": {
    "defaultProfile": "openai-codex:default",
    "preferCliImport": true
  },
  "storage": {
    "sqlitePath": "./data/mottbot.sqlite"
  },
  "behavior": {
    "respondInGroupsOnlyWhenMentioned": true,
    "editThrottleMs": 750
  },
  "oauth": {
    "callbackHost": "127.0.0.1",
    "callbackPort": 1455
  }
}
```

## Session Identity

The session key is the primary identity boundary for queueing, transcript storage, and route settings.

### Session key taxonomy

| Route kind | Example |
| --- | --- |
| private chat | `tg:dm:123:user:123` |
| private chat without user ID | `tg:dm:123` |
| group | `tg:group:-1001111111111` |
| topic | `tg:group:-1001111111111:topic:42` |
| bound route | `tg:bound:here` |

## Core Domain Records

### Session route

Persistent route configuration:

- session key
- chat ID
- optional thread ID
- optional user ID
- route mode
- optional bound name
- profile ID
- model ref
- fast mode
- optional system prompt
- timestamps

### Transcript message

Persistent conversational record:

- message ID
- session key
- optional run ID
- role: `user`, `assistant`, `system`, `tool`
- optional Telegram message IDs
- optional text payload
- optional JSON payload
- created timestamp

### Run record

Persistent execution record:

- run ID
- session key
- status
- model ref
- profile ID
- optional transport
- optional request identity
- optional start and finish timestamps
- optional error code and message
- optional usage JSON
- timestamps

## Run Status Lifecycle

Current status set:

- `queued`
- `starting`
- `streaming`
- `completed`
- `failed`
- `cancelled`

Typical lifecycle:

```text
queued -> starting -> streaming -> completed
queued -> starting -> failed
queued -> starting -> streaming -> failed
queued -> starting -> cancelled
queued -> starting -> streaming -> cancelled
```

## SQLite Schema

SQLite runs in WAL mode and acts as the system of record.

### `auth_profiles`

Purpose:

- encrypted credential storage for local OAuth and imported Codex CLI credentials

Notable fields:

- `profile_id`
- `provider`
- `source`
- `access_token_ciphertext`
- `refresh_token_ciphertext`
- `expires_at`
- `account_id`

### `session_routes`

Purpose:

- persistent session routing and mutable session settings

Notable fields:

- `session_key`
- `chat_id`
- `thread_id`
- `route_mode`
- `profile_id`
- `model_ref`
- `fast_mode`
- `system_prompt`

### `messages`

Purpose:

- transcript storage for user and assistant history

Notable fields:

- `session_key`
- `run_id`
- `role`
- `telegram_message_id`
- `content_text`
- `content_json`

### `runs`

Purpose:

- execution audit trail

Notable fields:

- `status`
- `model_ref`
- `profile_id`
- `transport`
- `request_identity`
- `error_code`
- `error_message`
- `usage_json`

### `telegram_updates`

Purpose:

- reserved for update dedupe and ingestion audit

Current state:

- table exists
- runtime does not yet write to it

### `outbox_messages`

Purpose:

- track the placeholder or final Telegram message associated with a run

Notable fields:

- `run_id`
- `chat_id`
- `thread_id`
- `telegram_message_id`
- `state`
- `last_rendered_text`
- `last_edit_at`

Current states used:

- `active`
- `final`
- `failed`

### `transport_state`

Purpose:

- remember recent WebSocket degradation per session

Notable fields:

- `session_key`
- `websocket_degraded_until`
- `last_transport`

## Encryption At Rest

`AuthProfileStore` encrypts access and refresh tokens with `SecretBox`.

Implementation details:

- AES-256-GCM
- 12-byte IV
- 16-byte auth tag
- master key derived from:
  - a raw 32-byte base64 secret when provided, or
  - a SHA-256 hash of the configured secret string

This is only used for auth profile storage. The Telegram bot token is read from environment configuration and is not persisted in SQLite.

## Data Retention

Current retention policy is simple:

- transcripts are append-only until `/reset` or `/new`
- runs are never pruned automatically
- auth profiles are updated in place
- outbox rows are kept after completion

There is no automatic compaction or archival task yet.

## Known Data-Model Gaps

- no schema version history beyond bootstrap migration
- no attachment blob storage
- no durable queue state
- no summarization state for long transcripts
- no dedicated health state for auth profiles beyond refresh failures
