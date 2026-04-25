# Mottbot Docs

These documents describe the current Telegram-first Codex bot runtime, operator workflows, and verification gates. Historical design briefs and phase plans are intentionally omitted once the implemented behavior is covered by source, release notes, and the current runbooks.

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
- [Code Quality](./code-quality.md)
  Local linting, formatting, naming, and TSDoc expectations.
- [Operations](./operations.md)
  Local setup, auth bootstrap, operator commands, deployment posture, and hardening backlog.
- [Persistent Setup](../SETUP.md)
  Host-local macOS LaunchAgent setup, restart commands, logs, and Telegram polling conflict handling.
- [Live Smoke Tests](./live-smoke-tests.md)
  Guarded polling, webhook, Codex, attachment, optional MTProto user-account, and fault-injection checks for a real test bot environment.
- [Tool Use](./tool-use-design.md)
  Safety requirements and runtime behavior for read-only and approval-gated model tool execution.
- [Release Notes](./release-notes.md)
  Operator-facing notes and validation checklists for newly added runtime capabilities.

## How To Read This Set

- Start with `architecture.md` if you want the system in one pass.
- Read `codex-subscription-provider.md` if your main interest is the subscription-backed Codex path.
- Read `telegram-runtime.md` and `data-model.md` if you want to reproduce the runtime behavior in another codebase.
- Read `testing.md` and `operations.md` if you want to ship or extend this repo.
- Read `tool-use-design.md` before enabling side-effecting model tools or Codex CLI jobs.

## Status

Current runtime summary:

- Telegram polling or webhook ingress with ACL, route resolution, per-session serialization, and durable outbox behavior.
- SQLite-backed auth, sessions, transcripts, runs, queue state, tool approvals, memory, roles, and chat policy.
- Subscription-backed `openai-codex` provider integration with local OAuth, Codex CLI auth import, token refresh, and transport fallback.
- Named agents, route bindings, local usage budgets, attachment extraction, approved memory, and admin diagnostics.
- Deny-by-default model tools with admin-only read tools and opt-in approval-gated side effects.
- Approval-gated Codex CLI job tools for coding tasks in configured repositories.
- Local operator dashboard, guarded live smoke commands, disposable local tool validation, backup/restore validation, log rotation, and host-local lease protection.

Known gaps:

- channel bindings beyond Telegram
- enabling native provider file blocks for non-image attachments when the provider exposes them
- billing-grade token or currency budgets if provider usage data becomes reliable enough to enforce
- fully automated webhook delivery and live Codex fault-injection smoke tests
- stronger restart reconciliation for in-progress Telegram deliveries
- distributed multi-instance coordination beyond the host-local lease
