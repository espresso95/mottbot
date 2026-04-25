# Data Model

## Configuration Model

Configuration comes from two layers:

1. defaults baked into `config.ts`
2. `mottbot.config.json`

Relative filesystem paths in runtime config are resolved from the process working directory, not from the config file's directory. The service commands start from the repository root, so repo-relative paths such as `./data/mottbot.sqlite` are stable for the normal launchd flow.

## Required Secrets

- `telegram.botToken` in `mottbot.config.json`
- `security.masterKey` in `mottbot.config.json`

## Useful Environment Variables

- `MOTTBOT_CONFIG_PATH`
- `CODEX_HOME`

## Default Runtime Settings

Current defaults:

```json
{
  "telegram": {
    "botToken": "<required>",
    "polling": true,
    "adminUserIds": [],
    "allowedChatIds": []
  },
  "security": {
    "masterKey": "<required>"
  },
  "models": {
    "default": "openai-codex/gpt-5.4",
    "transport": "auto"
  },
  "auth": {
    "defaultProfile": "openai-codex:default",
    "preferCliImport": true
  },
  "agents": {
    "defaultId": "main",
    "list": [],
    "bindings": []
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
    "restartDelayMs": 60000,
    "policies": {},
    "repository": {
      "roots": ["."],
      "deniedPaths": [],
      "maxReadBytes": 40000,
      "maxSearchMatches": 100,
      "maxSearchBytes": 80000,
      "commandTimeoutMs": 5000
    },
    "localWrite": {
      "roots": ["./data/tool-notes"],
      "deniedPaths": [],
      "maxWriteBytes": 20000
    },
    "telegramSend": {
      "allowedChatIds": []
    },
    "github": {
      "defaultRepository": "owner/name",
      "command": "gh",
      "commandTimeoutMs": 10000,
      "maxItems": 10,
      "maxOutputBytes": 80000
    }
  },
  "runtime": {
    "instanceLeaseEnabled": true,
    "instanceLeaseTtlMs": 120000,
    "instanceLeaseRefreshMs": 30000
  },
  "service": {
    "label": "ai.mottbot.bot"
  },
  "usage": {
    "dailyRuns": 0,
    "dailyRunsPerUser": 0,
    "dailyRunsPerChat": 0,
    "dailyRunsPerSession": 0,
    "dailyRunsPerModel": 0,
    "monthlyRuns": 0,
    "monthlyRunsPerUser": 0,
    "monthlyRunsPerChat": 0,
    "monthlyRunsPerSession": 0,
    "monthlyRunsPerModel": 0,
    "warningThresholdPercent": 80
  }
}
```

Agent entries may include `displayName`, `profileId`, `modelRef`, `fastMode`, `systemPrompt`, `toolNames`, `toolPolicies`, `maxConcurrentRuns`, and `maxQueuedRuns`. `toolNames` is an allow-list for model-exposed tools when that agent is selected and accepts exact tool names or group selectors such as `group:fs`. `toolPolicies` uses the same shape as global tool policy entries and is applied as an additional restriction, not a relaxation of global policy. Agent run limits are host-local controls: `maxConcurrentRuns` limits active execution and `maxQueuedRuns` limits persisted queued backlog for that agent.

## Session Identity

The session key is the primary identity boundary for queueing, transcript storage, and route settings.

### Session key taxonomy

| Route kind                   | Example                            |
| ---------------------------- | ---------------------------------- |
| private chat                 | `tg:dm:123:user:123`               |
| private chat without user ID | `tg:dm:123`                        |
| group                        | `tg:group:-1001111111111`          |
| topic                        | `tg:group:-1001111111111:topic:42` |
| bound route                  | `tg:bound:here`                    |

## Core Domain Records

### Session route

Persistent route configuration:

- session key
- chat ID
- optional thread ID
- optional user ID
- route mode
- optional bound name
- agent ID
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
- agent ID
- status
- model ref
- profile ID
- optional transport
- optional request identity
- optional start and finish timestamps
- optional error code and message
- optional usage JSON
- timestamps

Usage budget enforcement reads accepted local run counts from this table joined to `session_routes`. Runs failed with `error_code = 'usage_budget_denied'` are excluded so rejected attempts do not consume the same budget that rejected them. These counters are operational guardrails, not authoritative provider billing records.

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
- `agent_id`
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

Attachment envelopes in `content_json` store metadata and extraction summaries only. They do not store raw downloaded bytes, raw extracted text, local cache paths, or Telegram file download URLs.

### `attachment_records`

Purpose:

- session-scoped retained file metadata for `/files`
- extraction audit metadata for active-run file understanding
- targeted forgetting without deleting unrelated transcript text

Notable fields:

- `id`
- `session_key`
- `run_id`
- `telegram_message_id`
- `kind`
- `file_id` and optional `file_unique_id`
- `file_name`, `mime_type`, and `file_size`
- `ingestion_status`, `ingestion_reason`, and `downloaded_bytes`
- `extraction_kind`, `extraction_status`, `extraction_reason`
- `extracted_text_chars`, `prompt_text_chars`, and `extraction_truncated`
- optional `language`, `row_count`, `column_count`, and `page_count`

### `runs`

Purpose:

- execution audit trail

Notable fields:

- `agent_id`
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
- stores the inbound event envelope and, for inline-approved tools, the approved tool continuation payload needed to replay the exact stored tool call after restart

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
- `request_fingerprint`
- `preview_text`
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
- `request_fingerprint`
- `preview_text`

Audit rows store sanitized previews only. They must not contain bearer tokens, refresh tokens, bot tokens, raw auth payloads, or local secret file contents.

### `session_memories`

Purpose:

- store approved long-term memory and optional deterministic automatic summaries

Notable fields:

- `session_key`
- `source`: `explicit`, `auto_summary`, or `model_candidate`
- `scope`: `session`, `personal`, `chat`, `group`, or `project`
- `scope_key`: the concrete session key, user ID, chat ID, group chat ID, or project key
- `content_text`
- `pinned`
- `archived_at`
- `source_candidate_id`
- timestamps

The model sees approved memory as system context before the recent transcript. Prompt rendering orders pinned accepted memory first, then project, personal, group, chat, session, and automatic summaries. Archived memory is not rendered. Project-scoped memory is visible when the resolved route has a matching `agents.bindings[].projectKey`.

Explicit memory is changed through `/remember`, `/memory`, and `/forget`; automatic summaries are updated only when `memory.autoSummariesEnabled=true` and can be cleared with `/forget auto`.

### `memory_candidates`

Purpose:

- store model-proposed memory candidates separately from accepted memory until they are explicitly reviewed or accepted by the configured automatic approval policy

Notable fields:

- `session_key`
- `scope` and `scope_key`
- `content_text`
- `reason`
- `source_message_ids_json`
- `sensitivity`: `low`, `medium`, or `high`
- `status`: `pending`, `accepted`, `rejected`, or `archived`
- `accepted_memory_id`
- decision and timestamp fields

Candidates are created only when `memory.candidateExtractionEnabled=true`. The extraction prompt asks for strict JSON, source message IDs, proposed scope, reason, and sensitivity. Malformed output is ignored and logged without failing the user-facing run. Extraction can use the existing Codex transport or LM Studio's local OpenAI-compatible endpoint. Pre-response extraction can run against a single user turn before prompt construction; post-response extraction can run after the assistant turn and may be scheduled asynchronously. When `memory.candidateApprovalPolicy="auto"`, pending candidates whose sensitivity is at or below `memory.autoAcceptMaxSensitivity` are immediately copied into `session_memories` as `model_candidate` memory. Higher-sensitivity candidates remain pending. `/memory accept <id-prefix>` copies a pending candidate into `session_memories`; `/memory reject`, `/memory edit`, `/memory archive candidate`, and `/memory clear candidates` manage the review queue.

### `telegram_user_roles`

Purpose:

- persistent Telegram role assignments for users not listed in bootstrap config
- owner/admin/trusted-user governance for multi-user operation

Notable fields:

- `user_id`
- `role`: `owner`, `admin`, or `trusted`
- `granted_by_user_id`
- `reason`
- timestamps

`telegram.adminUserIds` are treated as config-source owners and are not duplicated into this table. Telegram commands cannot revoke or downgrade configured owners. Removing the last database owner is rejected when no config owner exists.

### `telegram_chat_policies`

Purpose:

- persistent per-chat governance policy
- restrict non-operator chat access, group command access, model refs, model tools, memory scopes, and stricter attachment limits

Policy JSON fields:

- `allowedRoles`
- `commandRoles`, including optional `*` wildcard
- `modelRefs`
- `toolNames`
- `memoryScopes`
- `attachmentMaxFileBytes`
- `attachmentMaxPerMessage`

Owner/admin users can still run governance commands for recovery if a chat policy would otherwise block command access.

### `telegram_governance_audit`

Purpose:

- append-only audit for role grants, role revokes, chat policy changes, and chat policy clears

Notable fields:

- `actor_user_id`
- `target_user_id`
- `chat_id`
- `action`
- `role`
- `previous_role`
- `policy_json`
- `reason`
- `created_at`

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
- consumed or expired tool approvals, active session memories, accepted candidate audit rows, and governance audit rows are retained until explicit future cleanup support is added
- archived session-memory rows and rejected or archived memory candidates can be pruned by age with `mottbot db prune`

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
- extraction kind, status, reason, prompt character count, truncation flag, language, table dimensions, and PDF page count

Supported image attachments can be downloaded into the local attachment cache and converted into base64 model input blocks. Native non-image file input is represented internally but disabled for the current Codex provider boundary, so supported text, Markdown, code, CSV, TSV, and PDF documents are downloaded and converted into bounded prompt-only text. Raw file bytes, raw extracted text, local cache paths, and Telegram file download URLs are not stored in SQLite.

The `/files` command reads `attachment_records`. `/files forget <id-prefix>` removes one record and strips the matching attachment envelope from transcript JSON. `/files clear` removes all file records for the current session and strips attachment envelopes from transcript JSON while preserving message text and unrelated transcript rows.

## Known Data-Model Gaps

- no attachment blob storage or durable file-cache table
- no durable raw extracted file-text storage by design
- no distributed queue state for multi-replica deployments beyond the host-local instance lease
- no model-generated summarization state for long transcripts
- no dedicated health state for auth profiles beyond refresh failures
- no automated SQLite rollback mechanism beyond restoring an operator backup
