# Mottbot Design Docs

These documents describe the Telegram-first Codex subscription bot implemented in this repo. They are aligned to the current codebase as verified on April 19, 2026.

## Doc Map

- [Architecture](./architecture.md)
  Overall system shape, module boundaries, startup flow, and key host-local runtime decisions.
- [Telegram Runtime](./telegram-runtime.md)
  Ingress normalization, ACL rules, routing, commands, queueing, run execution, and Telegram rendering behavior.
- [Codex Subscription Provider](./codex-subscription-provider.md)
  The exact `openai-codex` path, OAuth and Codex CLI auth reuse, token resolution, transport fallback, and usage fetch behavior.
- [Data Model](./data-model.md)
  Config, session keys, SQLite schema, entity lifecycles, and secret storage.
- [Testing](./testing.md)
  Unit and integration test coverage, verified results, and current gaps.
- [Operations](./operations.md)
  Local setup, auth bootstrap, operator commands, deployment posture, and hardening backlog.
- [Persistent Setup](../SETUP.md)
  Host-local macOS LaunchAgent setup, restart commands, logs, and Telegram polling conflict handling.
- [Live Smoke Tests](./live-smoke-tests.md)
  Guarded polling, webhook, Codex, attachment, and fault-injection checks for a real test bot environment.
- [Tool Use Design](./tool-use-design.md)
  Safety requirements and implementation phases for future model tool execution.
- [Completion And Test Plan](./completion-test-plan.md)
  Phased implementation and verification roadmap for closing the remaining v1 hardening gaps.
- [Single-File Design Brief](./telegram-codex-design.md)
  The original one-file design brief that preceded the implementation.

## How To Read This Set

- Start with `architecture.md` if you want the system in one pass.
- Read `codex-subscription-provider.md` if your main interest is the subscription-backed Codex path.
- Read `telegram-runtime.md` and `data-model.md` if you want to reproduce the runtime behavior in another codebase.
- Read `testing.md` and `operations.md` if you want to ship or extend this repo.
- Read `completion-test-plan.md` if you want the remaining work broken into implementation and test phases.

## Status

Implemented in this repo:

- Telegram polling bot via `grammY`
- normalized Telegram ingress
- ACL and route resolution
- per-session run serialization
- SQLite-backed session, transcript, run, outbox, and auth storage
- Subscription-backed `openai-codex` provider boundary
- local OAuth login command
- Codex CLI auth import
- token refresh with per-profile locking
- refresh failure handling that avoids reverting refreshed CLI-backed credentials to stale tokens
- WebSocket-first streaming with SSE fallback
- durable Telegram update dedupe
- reply-to-bot gating in groups via persisted bot-message tracking
- restart recovery for interrupted runs
- durable queued-run recovery after restart
- versioned SQLite migration tracking
- native image attachment ingestion and attachment-aware prompt construction
- operator safety limits for inbound text and attachments
- transcript compaction via deterministic history summaries
- webhook mode
- health reporting via `/health` and `mottbot health`
- queued/active/stale outbox health counters and safer structured run logs
- outbox mid-stream rebind to continuation messages when Telegram edits fail
- unit and integration test suite with coverage reporting
- tool-use safety design documentation

Planned hardening that is not yet implemented:

- native non-image attachment ingestion into model inputs
- fully automated inbound live Telegram and Codex smoke tests
- model-executed tools
- stronger restart reconciliation for in-progress Telegram deliveries
- richer summarization beyond deterministic local compaction
- multi-instance coordination
