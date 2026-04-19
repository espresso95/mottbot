# Mottbot Design Docs

These documents describe the Telegram-first Codex subscription bot implemented in this repo. They are aligned to the current codebase as verified on April 19, 2026.

## Doc Map

- [Architecture](./architecture.md)
  Overall system shape, module boundaries, startup flow, and the key design decisions copied from OpenClaw.
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
- [Completion And Test Plan](./completion-test-plan.md)
  Phased implementation and verification roadmap for closing the remaining v1 hardening gaps.
- [Single-File Design Brief](./telegram-codex-design.md)
  The original one-file design brief that preceded the implementation.

## How To Read This Set

- Start with `architecture.md` if you want the system in one pass.
- Read `codex-subscription-provider.md` if your main interest is the OpenClaw-style subscription path.
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
- OpenClaw-style `openai-codex` provider boundary
- local OAuth login command
- Codex CLI auth import
- token refresh with per-profile locking
- WebSocket-first streaming with SSE fallback
- durable Telegram update dedupe
- reply-to-bot gating in groups via persisted bot-message tracking
- restart recovery for interrupted runs
- durable queued-run recovery after restart
- native image attachment ingestion and attachment-aware prompt construction
- transcript compaction via deterministic history summaries
- webhook mode
- health reporting via `/health` and `mottbot health`
- outbox mid-stream rebind to continuation messages when Telegram edits fail
- unit and integration test suite with coverage reporting

Planned hardening that is not yet implemented:

- native non-image attachment ingestion into model inputs
- stronger restart reconciliation for in-progress Telegram deliveries
- richer summarization beyond deterministic local compaction
- multi-instance coordination
