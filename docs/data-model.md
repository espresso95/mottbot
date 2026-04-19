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
- `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS`
- `MOTTBOT_TOOL_APPROVAL_TTL_MS`
- `MOTTBOT_RESTART_TOOL_DELAY_MS`
- `MOTTBOT_INSTANCE_LEASE_ENABLED`
- `MOTTBOT_DEFAULT_MODEL`
- `MOTTBOT_TRANSPORT`
- `MOTTBOT_DEFAULT_PROFILE`
- `MOTTBOT_PREFER_CLI_IMPORT`
- `MOTTBOT_SQLITE_PATH`
- `MOTTBOT_ATTACHMENT_CACHE_DIR`
- `MOTTBOT_ATTACHMENT_MAX_FILE_BYTES`
- `MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE`
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
  },
  "tools": {
    "enableSideEffectTools": false,
    "approvalTtlMs": 300000,
    "restartDelayMs": 60000
  },
  "runtime": {
    "instanceLeaseEnabled": true,
    "instanceLeaseTtlMs": 120000,
    "instanceLeaseRefreshMs": 30000
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

For `tool` rows, `content_json` stores the provider tool-call ID, tool name, validated arguments, elapsed time, output byte count, truncation flag, and optional error code. It must not store credentials, bearer tokens, refresh tokens, raw auth payloads, or large raw tool output.

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

### `schema_migrations`

Purpose:

- record ordered database migrations that have been applied to the SQLite file
- reject startup if an already-applied migration file has been modified

Notable fields:

- `version`
- `name`
- `checksum`
- `applied_at`

Current migration behavior:

- `0001_initial.sql` is the baseline schema migration
- migrations are idempotent and can be run repeatedly with `mottbot db migrate`
- existing unversioned databases that already have current tables are bootstrapped into the ledger without dropping rows

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

### `run_queue`

Purpose:

- durable restart metadata for accepted but not-yet-completed runs

Notable fields:

- `run_id`
- `session_key`
- `chat_id`
- `thread_id`
- `message_id`
- `reply_to_message_id`
- `event_json`
- `state`
- `attempts`
- `claimed_at`
- `lease_expires_at`

Current states used:

- `queued`
- `claimed`
- `completed`
- `failed`

The queue table is still scoped to a single process. Leases prevent duplicate restart claims in the supported local runtime; they are not a distributed lock for multiple replicas.

### `telegram_updates`

Purpose:

- durable Telegram update dedupe and ingestion audit

Current state:

- `TelegramUpdateStore` checks this table before accepting an update
- processed updates are written after handled commands, accepted model-run handoff, and access-rejected updates
- inflight update IDs are also tracked in memory so concurrent duplicate delivery is ignored before persistence

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

### `tool_approvals`

Purpose:

- store one-shot session-scoped approvals for side-effecting tools

Notable fields:

- `session_key`
- `tool_name`
- `approved_by_user_id`
- `reason`
- `approved_at`
- `expires_at`
- `consumed_at`

### `tool_approval_audit`

Purpose:

- record every side-effecting tool decision before execution

Notable fields:

- `session_key`
- `run_id`
- `tool_name`
- `side_effect`
- `allowed`
- `decision_code`
- `approved_by_user_id`
- `reason`

### `session_memories`

Purpose:

- store explicit operator/user-provided long-term memory and optional deterministic automatic summaries for a session

Notable fields:

- `session_key`
- `source`: `explicit` or `auto_summary`
- `content_text`
- timestamps

The model sees session memory as system context before the recent transcript. Explicit memory is changed through `/remember`, `/memory`, and `/forget`; automatic summaries are updated only when `MOTTBOT_AUTO_MEMORY_SUMMARIES=true` and can be cleared with `/forget auto`.

### `app_instance_leases`

Purpose:

- prevent accidental overlapping bot instances against the same SQLite database

Notable fields:

- `lease_name`
- `owner_id`
- `expires_at`
- `updated_at`

This is a host-local safety lease. It is not a distributed multi-replica coordination system.

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

Current retention policy is explicit but operator-driven:

- transcripts are append-only until `/reset`, `/new`, or `mottbot db prune`
- terminal runs can be pruned by age with `mottbot db prune`
- queued, starting, and streaming runs are retained for recovery
- active outbox rows are retained
- completed and failed queue rows can be pruned by age
- processed Telegram update IDs can be pruned by age
- old bot-message ACL rows can be pruned, which means replies to those old Telegram messages will no longer be accepted only by reply relationship
- auth profiles are updated in place
- session routes are not pruned by the retention helper
- consumed or expired tool approvals and session memories are retained until explicit future cleanup support is added

There is no automatic compaction or archival task yet. Operators should back up SQLite before destructive pruning.

## Attachment Metadata

The event and transcript metadata can carry:

- attachment kind
- Telegram `file_id` and `file_unique_id`
- file name
- MIME type
- byte size
- image dimensions
- audio or video duration
- ingestion status and reason

Supported image attachments can also be downloaded into the local attachment cache and converted into base64 model input blocks. Raw file bytes and local cache paths are not stored in SQLite.

## Known Data-Model Gaps

- no attachment blob storage or durable file-cache table
- no distributed queue state for multi-replica deployments beyond the host-local instance lease
- no model-generated summarization state for long transcripts
- no dedicated health state for auth profiles beyond refresh failures
- no automated SQLite rollback mechanism beyond restoring an operator backup
