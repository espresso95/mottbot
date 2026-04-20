# Mottbot Design Docs

These documents describe the Telegram-first Codex subscription bot implemented in this repo. They are aligned to the current codebase as verified on April 20, 2026.

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
  Guarded polling, webhook, Codex, attachment, optional MTProto user-account, and fault-injection checks for a real test bot environment.
- [Tool Use Design](./tool-use-design.md)
  Safety requirements and runtime behavior for read-only and approval-gated model tool execution.
- [Completion And Test Plan](./completion-test-plan.md)
  Phased implementation and verification roadmap for closing the remaining hardening gaps.
- [Release Notes](./release-notes.md)
  Operator-facing notes and validation checklists for newly added runtime capabilities.
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
- config-defined named agents and Telegram route bindings
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
- capability-gated native file attachment plumbing with classified-document guards and safe fallback while Codex file blocks remain unsupported
- bounded text, Markdown, code, CSV, TSV, and PDF attachment extraction for active model runs
- session file metadata inspection and forgetting through `/files`
- operator safety limits for inbound text and attachments
- transcript compaction via deterministic history summaries
- webhook mode
- health reporting via `/health` and `mottbot health`
- queued/active/stale outbox health counters and safer structured run logs
- outbox mid-stream rebind to continuation messages when Telegram edits fail
- unit and integration test suite with coverage reporting
- GitHub Actions CI for install, native SQLite rebuild, typecheck, tests, coverage, build, package validation, and dirty-worktree guard
- tool-use safety design documentation
- deny-by-default tool registry, read-only health snapshot execution, and opt-in one-shot-approved restart tool execution
- read-only operator diagnostics tools and admin `/runs` and `/debug` commands
- admin-only read-only local repository and git inspection tools
- admin-only read-only GitHub repository, pull request, issue, and CI inspection through the host GitHub CLI
- admin-only approval-gated local note/document writes, allowlisted local command execution, MCP stdio calls, GitHub issue/comment writes, and Telegram send/reaction tools
- local operator dashboard panels for runtime health, logs, tools, approvals, memory, and guarded restart controls
- scoped approved memory through `/remember`, `/memory`, and `/forget`, optional deterministic automatic summaries, and opt-in model-proposed memory candidates with review commands
- persistent owner/admin/trusted Telegram roles and per-chat governance policy through `/users`
- caller-aware `/help`, `/commands`, and `/tool help` filtered by role, chat type, enabled features, and per-chat command policy
- local UTC daily and monthly usage budgets with `/usage` reporting
- repeatable guarded live validation suite for preflight, private-chat, command, reply, group, and attachment checks
- disposable local tool validation for document edits, allowlisted commands, and MCP stdio calls
- guarded disposable GitHub write validation for issue/comment tools
- host-local backup, restore validation, and launchd log rotation commands
- host-local instance lease to reduce accidental overlapping bot processes

Planned hardening that is not yet implemented:

- runtime agent switching commands and per-agent tool/concurrency policy
- enabling native provider file blocks for non-image attachments when the provider exposes them
- billing-grade token or currency budgets if provider usage data becomes reliable enough to enforce
- fully automated webhook delivery and live Codex fault-injection smoke tests
- stronger restart reconciliation for in-progress Telegram deliveries
- distributed multi-instance coordination beyond the host-local lease
