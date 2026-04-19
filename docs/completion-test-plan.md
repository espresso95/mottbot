# Mottbot Completion And Test Plan

## Purpose

This document breaks the remaining work for Mottbot into implementation and verification phases. It assumes the current baseline is the existing Telegram-first, SQLite-backed Codex subscription bot with passing local TypeScript and Vitest checks.

The goal is to move the project from a working local scaffold into a hardened single-host operator bot with complete attachment handling, durable run recovery, disciplined migrations, live integration validation, and production-ready operational documentation.

## Implementation Status

As of April 19, 2026:

- Phase 0 is complete.
- Phase 1 is complete for the documented runtime hardening scope: deterministic run timestamps, command authorization, command input validation, and operator-driven retention pruning.
- Phase 2 is complete for the single-host scope: Telegram image attachments are downloaded safely, converted into native model image inputs when supported, represented as text metadata otherwise, and cleaned from the local cache after request construction.
- Phase 3 durable queue recovery is implemented for the single-process deployment model: accepted queued runs are persisted, claimed with leases, resumed on restart when recoverable, and marked failed when not recoverable.
- Phase 4 is complete: SQLite migrations now use an ordered `schema_migrations` ledger, the current schema is captured in `0001_initial.sql`, migration integrity is checked by checksum, and migration tests cover empty databases, unversioned databases, indexes, foreign keys, and checksum mismatch failure.
- Phase 5 is complete for local hardening: token refresh failure paths, CLI write-back failure behavior, provider model ref validation, usage timeout/error normalization, and `/status` usage degradation are covered by tests.
- Phase 6 live validation is prepared with guarded preflight and MTProto user-account smoke commands. The preflight validates Telegram `getMe`, optional outbound `sendMessage`, migrations, health counters, and auth profile presence. The MTProto harness can drive private-chat, group-target, reply-gating, and file-upload checks from the CLI when the operator provides the target chat and fixtures. Webhook delivery, OAuth, and broader live Codex behavior still require an operator-provided live integration environment.
- Phase 7 has a host-local persistent service path for macOS: `launchd` service install/start/stop/restart/status commands, a top-level `restart` command, setup documentation, and polling-conflict retry behavior.
- Phase 7.1 observability is implemented for queued/active/stale outbox health counters and safe structured run lifecycle logs.
- Phase 7.2 operator safety limits are implemented for inbound text length, attachment count, per-file attachment size, and combined known attachment size. Rejected messages receive a Telegram reply and do not create queued work.
- Phase 8 is complete for release readiness: GitHub Actions CI installs with pnpm, rebuilds `better-sqlite3`, runs typecheck/tests/coverage/build/package validation, and fails on dirty generated output.
- Phase 9 is complete for the read-only v1 tool scope and the first opt-in side-effect tool: a deny-by-default registry exposes `mottbot_health_snapshot`, optionally exposes `mottbot_restart_service`, Codex provider tool-call events are normalized, tools execute with timeout/output/call limits, side-effecting tools require one-shot admin approval, tool result and approval metadata is persisted, and Telegram shows concise tool status.
- Phase 10 has started with concrete scoped implementations: explicit session memory, a model-provider boundary for orchestration, and a host-local instance lease to prevent accidental overlapping bot processes. Full multi-replica coordination and second-provider support remain backlog items.

## Current Baseline

Verified locally on April 19, 2026:

- `corepack pnpm check` passes.
- `corepack pnpm test` passes with 46 test files and 151 tests.
- `corepack pnpm test:coverage` passes with statements 84.73%, branches 73.81%, functions 90.93%, and lines 84.78%.
- `corepack pnpm build` passes.
- `node dist/index.js health` passes against a temporary local SQLite path after build.
- `corepack pnpm smoke:preflight` passes in skipped mode when `MOTTBOT_LIVE_SMOKE_ENABLED` is unset.
- `corepack pnpm smoke:telegram-user` passes in skipped mode by default and passed live against `StartupMottBot` after the persistent service was restarted.
- The current test suite covers local state transitions, command behavior, Codex auth parsing and refresh, transport fallback, outbox behavior, and mocked run orchestration.

Current known gaps:

- Native attachment ingestion is limited to image inputs for models that advertise image support; unsupported files remain text metadata.
- Durable queue recovery is designed for one process and one SQLite database, not multiple active replicas.
- Inbound Telegram validation can be driven by the optional MTProto user smoke harness when the operator provides target chats and fixtures, but webhook delivery, OAuth, and full live Codex validation still require an operator-provided live environment.
- Model-executed tools are limited to the health snapshot and the opt-in delayed restart tool. Other side-effect categories remain disabled.
- Multi-instance coordination is limited to a host-local SQLite lease; distributed replicas remain out of scope.

## Definition Of Complete

Mottbot is complete for the intended v1 single-host operator use case when:

- Private chats, bound group routes, mention-gated group replies, and reply-to-bot flows work in live Telegram.
- Text, image, and supported file attachments are ingested safely and passed to the model when supported.
- Runs are durable enough that process restarts do not silently strand accepted user work.
- Interrupted delivery state is reconciled clearly in Telegram after restart.
- Schema changes use explicit migrations with rollback or recovery guidance.
- Auth refresh, transport fallback, usage reporting, dashboard config, and command handling are tested across success and failure paths.
- The operator runbooks describe setup, auth, deployment, failure recovery, and verification commands.
- The repo is clean after verification and contains no generated output.

## Phase 0: Baseline And Planning

### Task 0.1: Align The Documented Current State

Deliverables:

- Update `docs/data-model.md` to remove the stale claim that `telegram_updates` is not written by the runtime.
- Add a short note that `TelegramUpdateStore` persists processed update IDs after commands, accepted runs, and access-rejected updates.
- Cross-check `docs/README.md`, `docs/architecture.md`, and `docs/telegram-runtime.md` for status drift against the current source.
- Add a small changelog entry or commit note summarizing the documentation correction.

### Task 0.2: Establish A Repeatable Local Verification Baseline

Deliverables:

- Document the exact local setup command sequence using `pnpm`.
- Document how to handle pnpm build-script approval for `better-sqlite3` on fresh installs.
- Confirm that `pnpm check` passes from a clean checkout after dependencies are installed.
- Confirm that `pnpm test` passes from a clean checkout after native dependencies are built.
- Capture the expected test count and any intentional stdout from mocked OAuth tests.

### Task 0.3: Define Test Environments And Secrets

Deliverables:

- Create an operator-only test environment checklist covering Telegram bot token, test chat IDs, admin user IDs, SQLite path, master key, and Codex auth source.
- Define separate local paths for development SQLite data and integration-test SQLite data.
- Document how to create and revoke a test Telegram bot.
- Document how to import Codex CLI auth and how to run local OAuth login.
- Document which environment variables must never be committed.

## Phase 1: Existing Runtime Hardening

### Task 1.1: Normalize Time And Clock Usage

Deliverables:

- Audit code paths that use `Date.now()` directly instead of the injected `Clock`.
- Replace direct runtime timestamps with `Clock` where test determinism or store consistency matters.
- Keep wall-clock use only where it is tied to external protocol behavior and document why.
- Add or update tests proving run timestamps and transport-state timestamps are deterministic where expected.

### Task 1.2: Tighten Command Authorization Semantics

Deliverables:

- Review whether all commands should be available to non-admin users in groups.
- Define command policy for private chats, allowed chats, admins, and bound group routes.
- Implement stricter authorization if needed, especially for `/auth`, `/profile`, `/bind`, `/unbind`, `/reset`, and `/stop`.
- Add tests for allowed and denied command paths.
- Update `docs/telegram-runtime.md` and `docs/operations.md` with final command authorization rules.

### Task 1.3: Improve Input Validation And User-Facing Errors

Deliverables:

- Validate model refs before `/model` persists them.
- Validate profile IDs and route binding names with clear limits.
- Add user-readable error messages for bad command arguments.
- Add tests for malformed command input, oversized binding names, unknown models, and empty profile IDs.
- Update docs with the accepted command syntax and failure messages.

### Task 1.4: Add Retention And Cleanup Boundaries For Existing Tables

Deliverables:

- Define retention rules for `runs`, `messages`, `telegram_updates`, `telegram_bot_messages`, and `outbox_messages`.
- Add cleanup helpers or CLI command skeletons for pruning old operational data.
- Add tests that pruning does not break active sessions, bot-reply ACL, or run history needed for recovery.
- Document safe cleanup commands and backup recommendations.

## Phase 2: Native Attachment Ingestion

### Task 2.1: Design Attachment Storage And Lifecycle

Deliverables:

- Define the attachment record shape for Telegram file metadata, local temporary path, MIME type, size, and cleanup status.
- Decide whether attachment metadata belongs in a new table or in `messages.content_json` plus local file cache records.
- Define size limits, supported MIME types, and unsupported attachment behavior.
- Document the attachment lifecycle from Telegram update to model request to cleanup.
- Add schema or type definitions for attachment metadata.

### Task 2.2: Download Telegram Files Safely

Deliverables:

- Implement a Telegram file resolver that calls `getFile` and downloads file bytes from Telegram.
- Store downloaded files under a configured local cache directory outside committed paths.
- Enforce maximum file size before download when Telegram metadata exposes size.
- Enforce maximum actual bytes during download.
- Add structured errors for unsupported type, too large, download failure, and missing file ID.
- Add unit tests with mocked Telegram file metadata and download responses.

### Task 2.3: Convert Attachments Into Model Inputs

Deliverables:

- Extend prompt/model payload construction to include native image inputs when the selected Codex model supports image input.
- Keep unsupported attachments as textual metadata when native ingestion is not available.
- Ensure model input generation stays isolated to `src/codex/*` or a narrow run-level adapter.
- Add tests for image-capable and text-only models.
- Add tests proving attachment file paths or raw bytes are not leaked into user-visible Telegram output.

### Task 2.4: Preserve Attachment Context In Transcripts

Deliverables:

- Persist stable attachment metadata with each user turn.
- Include user-friendly attachment summaries in transcript history.
- Avoid persisting raw file contents in SQLite.
- Add tests for transcript persistence, prompt rendering, and reset behavior with attachment records.
- Update `docs/data-model.md` and `docs/telegram-runtime.md`.

### Task 2.5: Add Attachment Cleanup And Failure Recovery

Deliverables:

- Delete temporary attachment files after successful model request construction when safe.
- Retain failed-run attachment files only when explicitly needed for recovery diagnostics.
- Add cleanup on `/reset` or retention pruning if attachment cache records are retained.
- Add tests for cleanup after success, cleanup after failure, and missing local file recovery behavior.
- Document cache location and operational cleanup procedure.

## Phase 3: Durable Queue And Restart Recovery

### Task 3.1: Add Durable Queue State

Deliverables:

- Define persisted fields needed to identify queued work after process restart.
- Decide whether to extend `runs` or add a dedicated `run_queue` table.
- Store enough inbound event context to execute an accepted queued turn after restart.
- Add migration and store APIs for queued work.
- Add integration tests for creating, reading, and claiming queued work.

### Task 3.2: Implement Single-Process Claim And Lease Semantics

Deliverables:

- Add a queue-claim mechanism that works safely for the supported single-process deployment.
- Record claimed-at, lease-expiration, and attempt count fields if a queue table is introduced.
- Ensure active in-memory queue behavior still serializes by `session_key`.
- Prevent duplicate execution of the same queued run after restart.
- Add tests for claim, complete, fail, retry, and duplicate-claim behavior.

### Task 3.3: Resume Or Fail Queued Runs Deterministically On Startup

Deliverables:

- Define startup behavior for `queued`, `starting`, and `streaming` runs.
- Resume unstarted queued runs when enough input context exists.
- Mark unrecoverable queued runs failed with a clear `error_code`.
- Preserve current behavior that marks interrupted `starting` and `streaming` runs failed unless true resume is implemented.
- Add restart-recovery integration tests using a fresh store instance.

### Task 3.4: Reconcile Telegram Delivery After Restart

Deliverables:

- Notify users when an accepted queued run is resumed after restart.
- Notify users when an accepted run cannot be resumed.
- Rebind or replace active outbox messages when possible.
- Add tests for re-notification success and Telegram send failure.
- Update `docs/operations.md` with restart recovery expectations.

## Phase 4: Versioned Migrations And Data Safety

### Task 4.1: Introduce Migration Version Tracking

Deliverables:

- Add a `schema_migrations` table or equivalent migration ledger.
- Split the current bootstrap schema into an initial migration.
- Make migrations idempotent and ordered.
- Keep `db migrate` safe to run repeatedly.
- Add tests for empty database migration and already-migrated database startup.

### Task 4.2: Add Forward Migration Tests

Deliverables:

- Create test fixtures for old schema versions when the next schema change is added.
- Verify data survives migration from old schema to current schema.
- Verify indexes and foreign keys exist after migration.
- Verify app bootstrap fails clearly on unrecoverable migration errors.
- Document how to add future migrations.

### Task 4.3: Define Backup And Rollback Guidance

Deliverables:

- Add an operator runbook for backing up SQLite before migration.
- Document WAL-related files that must be copied with the main database.
- Document rollback expectations for local single-host deployments.
- Add a dry-run or preflight migration check if feasible.
- Update `docs/operations.md`.

## Phase 5: Auth And Codex Provider Hardening

### Task 5.1: Exercise Real OAuth And CLI Auth Flows

Deliverables:

- Run `pnpm auth:import-cli` against a real Codex CLI `auth.json`.
- Run `pnpm auth:login` against a real operator account in a local test environment.
- Confirm encrypted profile storage and profile identity fields.
- Confirm token resolver can resolve API keys for both auth sources.
- Document any required operator browser or callback behavior.

### Task 5.2: Harden Token Refresh Failure Paths

Deliverables:

- Add tests for expired credentials with missing refresh token.
- Add tests for failed refresh from `@mariozechner/pi-ai/oauth`.
- Add tests for CLI write-back failure that still keeps local state coherent.
- Ensure no access tokens, refresh tokens, or raw auth payloads are logged.
- Update auth troubleshooting docs.

### Task 5.3: Validate Provider Model Selection

Deliverables:

- Add a model catalog validation helper for known Codex model refs.
- Decide whether unknown model refs are allowed as advanced/operator override.
- Make `/model` behavior match that decision.
- Add tests for known models, unknown models, and model capability differences.
- Update provider docs with supported model refs and override behavior.

### Task 5.4: Strengthen Usage Reporting

Deliverables:

- Add timeout and error-shape tests for usage fetch.
- Ensure `/status` degrades gracefully when usage is unavailable.
- Include plan/window reset details where available.
- Avoid exposing account identifiers unnecessarily in Telegram.
- Update `/status` documentation.

## Phase 6: Live Telegram And Codex Integration Testing

### Task 6.1: Create A Live Telegram Test Matrix

Deliverables:

- Define manual and automated smoke tests for private chat, group mention, group reply, bound group route, topic route, commands, long responses, and failure messages.
- Define expected Telegram messages for each scenario.
- Identify which tests can run safely against a real bot token.
- Create a test checklist for polling mode.
- Create a test checklist for webhook mode.

### Task 6.2: Test Live Polling Mode

Deliverables:

- Start the bot in polling mode with a test Telegram bot token.
- Verify private chat response.
- Verify group mention gating.
- Verify reply-to-bot gating.
- Verify command handling and update dedupe.
- Capture logs and document any operational findings.

### Task 6.3: Test Live Webhook Mode

Deliverables:

- Configure a public HTTPS webhook endpoint for the local or test deployment.
- Verify webhook registration through Telegram.
- Verify valid webhook delivery.
- Verify invalid path and method rejection.
- Verify secret-token behavior when configured.
- Document webhook setup and teardown steps.

### Task 6.4: Test Live Codex Model Calls

Deliverables:

- Run at least one successful text-only live Codex model call.
- Run at least one streaming response that edits the Telegram placeholder.
- Verify usage fetch after a successful run.
- Verify transport fallback behavior if WebSocket can be induced to fail before progress.
- Record expected latency and failure modes in operations docs.

### Task 6.5: Fault Injection And Recovery Tests

Deliverables:

- Simulate Telegram edit failure and verify outbox fallback sends a replacement message.
- Simulate process restart during queued, starting, and streaming states.
- Simulate auth refresh failure.
- Simulate model transport failure before and after stream progress.
- Document the exact user-visible behavior for each fault.

## Phase 7: Operational Hardening

### Task 7.1: Improve Observability

Deliverables:

- Add structured log fields for session key, run ID, chat ID, transport, and failure code where safe.
- Ensure logs never include credentials, raw auth payloads, or full sensitive prompts by default.
- Add health fields for queued runs, active runs, and stale outbox rows.
- Add tests for health snapshots where practical.
- Update logging and health documentation.

### Task 7.2: Add Operator Safety Limits

Deliverables:

- Define maximum inbound text length.
- Define maximum attachment count and total attachment size.
- Define per-chat or per-user rate limits if needed.
- Add clear Telegram replies for rejected oversized or unsupported inputs.
- Add tests for all configured limits.

### Task 7.3: Harden Dashboard Operations

Deliverables:

- Review dashboard editable config fields and add missing safe fields if needed.
- Add validation for model refs and profile IDs in dashboard config writes.
- Add CSRF or same-origin notes if dashboard is ever exposed beyond loopback.
- Keep the current non-loopback auth-token guard.
- Add tests for new validation and security behavior.

### Task 7.4: Finalize Deployment Documentation

Deliverables:

- Document single-host deployment assumptions.
- Document recommended process manager setup.
- Document environment variables and config-file precedence.
- Document backup, migration, auth refresh, and restart recovery operations.
- Document known non-goals: multi-instance operation, public shared bot posture, and generic plugin support.

## Phase 8: Release Readiness

### Task 8.1: Establish CI Verification

Status: complete.

Deliverables:

- Add CI jobs for dependency install, TypeScript check, unit/integration tests, and coverage.
- Ensure native `better-sqlite3` build scripts run in CI.
- Cache pnpm dependencies safely.
- Fail CI on generated output or dirty worktree after tests.
- Document required CI secrets only if live integration jobs are added.

### Task 8.2: Define Coverage Gates

Status: complete.

Deliverables:

- Decide minimum statement, branch, function, and line coverage thresholds.
- Add coverage threshold config if appropriate.
- Keep higher-risk modules covered: auth, transport fallback, run orchestration, Telegram commands, stores, and recovery.
- Add tests for any branch gaps introduced by the completion work.
- Document how to run coverage locally.

### Task 8.3: Build And Packaging Validation

Status: complete.

Deliverables:

- Run `pnpm build` and verify emitted `dist/` output works with `pnpm start`.
- Verify the `mottbot` bin entry points to the built CLI.
- Verify package metadata does not imply unsupported public-product readiness.
- Confirm `dist/` remains ignored and uncommitted.
- Document build and start commands.

### Task 8.4: Final Acceptance Run

Status: complete for local and guarded preflight validation. Live inbound Telegram and live Codex validation still require operator-provided live environment values.

Deliverables:

- Run `pnpm check`.
- Run `pnpm test`.
- Run `pnpm test:coverage`.
- Run targeted live Telegram and live Codex smoke tests in the designated test environment.
- Confirm docs match final behavior.
- Confirm `git status --short` contains only intentional source and docs changes.

## Phase 9: Tool Use Design And Safety

Mottbot executes registry-approved read-only model tools by default. The first side-effecting tool, `mottbot_restart_service`, is opt-in and requires one-shot admin approval, audit persistence, and a delayed execution guard.

### Task 9.1: Define Tool Registry

Status: complete.

Deliverables:

- Create typed tool definitions with name, description, JSON schema, timeout, and side-effect level.
- Add a registry that rejects unknown tools.
- Add tests for schema validation, unknown tools, and disabled side-effecting tools.
- Document the initial read-only tool set.

### Task 9.2: Add Provider Tool-Call Boundary

Status: complete.

Deliverables:

- Determine the exact `@mariozechner/pi-ai` tool-call event shapes for the Codex provider.
- Keep provider-specific parsing in `src/codex/*`.
- Add mocked transport tests for tool-call start, arguments, completion, and malformed events.
- Ensure normal text streaming still works when no tools are requested.

### Task 9.3: Execute Read-Only Tools

Status: complete.

Deliverables:

- Execute only registry-approved read-only tools.
- Enforce timeout, output-size, and max-call limits.
- Persist tool call and result metadata without credentials or large raw payloads.
- Add integration tests across run orchestration and transcript persistence.

### Task 9.4: Add Telegram Operator UX

Status: complete.

Deliverables:

- Show when a tool call is running.
- Show concise tool results in Telegram when useful.
- Add clear failure messages for denied, timed-out, or invalid tool calls.
- Add tests for user-visible tool-call states.

### Task 9.5: Implement Side-Effect Approval

Status: complete for the initial process-control scope.

Deliverables:

- Define approval prompts for local writes, network calls, and process-control tools.
- Add expiration for pending approvals.
- Add audit records for approved and denied calls.
- Keep side-effecting tools disabled by default and expose the restart tool only when the host opts in.

## Phase 10: Post-V1 Backlog

These items are not required to complete the current single-host operator bot, but they should remain visible for future planning.

### Task 10.1: Multi-Instance Coordination

Status: started for host-local protection.

Deliverables:

- Document why SQLite plus in-memory queue is insufficient for multiple replicas.
- Add a host-local `app_instance_leases` guard to prevent accidental overlapping bot processes.
- Design distributed locking or external queue requirements.
- Define how session serialization would work across processes.
- Define migration and deployment changes needed for multi-instance operation.
- Keep this out of v1 unless deployment requirements change.

### Task 10.2: Rich Long-Term Memory

Status: started with explicit session memory.

Deliverables:

- Add explicit session memory records managed by `/remember`, `/memory`, and `/forget`.
- Include session memory in prompt construction as system context.
- Add tests for memory storage, memory inclusion, and command behavior.
- Evaluate model-generated summaries or structured memory records as a later enhancement.
- Add operator controls for clearing or inspecting memory.
- Update prompt and data-model docs.

### Task 10.3: Provider Abstraction Beyond Codex

Status: started with an orchestration boundary.

Deliverables:

- Define the smallest provider interface needed by `RunOrchestrator`.
- Route `RunOrchestrator` through model token, transport, and capability interfaces while the current implementation remains Codex-backed.
- Keep Telegram/session modules provider-agnostic.
- Add tests proving provider swap does not affect Telegram routing.
- Document supported providers and auth modes.
- Avoid adding this until there is a real second provider requirement.
