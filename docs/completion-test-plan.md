# Mottbot Completion And Test Plan

## Purpose

This document breaks the remaining work for Mottbot into implementation and verification phases. It assumes the current baseline is the existing Telegram-first, SQLite-backed Codex subscription bot with passing local TypeScript and Vitest checks.

The goal is to move the project from a working local scaffold into a hardened single-host operator bot with complete attachment handling, durable run recovery, disciplined migrations, live integration validation, and production-ready operational documentation.

## Implementation Status

As of April 20, 2026:

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
- Phase 9 is complete for the read-only tool scope and the first opt-in side-effect tool: a deny-by-default registry exposes health and operator diagnostics tools, optionally exposes admin-only `mottbot_restart_service`, Codex provider tool-call events are normalized, tools execute with timeout/output/call limits, side-effecting tools require one-shot admin approval, tool result and approval metadata is persisted, and Telegram shows concise tool status.
- Phase 10 has concrete scoped implementations: explicit session memory, optional deterministic automatic summaries, admin diagnostics commands, a model-provider boundary for orchestration, and a host-local instance lease to prevent accidental overlapping bot processes. Full multi-replica coordination and second-provider support remain backlog items.
- Phase 11 is complete for command discovery and conversation UX: `/help`, `/commands`, `/tool help`, `/tools`, policy-aware help filtering, stable run status text, smoke transient filtering, and interrupted-run transient filtering are implemented and tested.
- Phase 12 is complete for Telegram reactions: the bot can send acknowledgement reactions while processing, optionally clear them after replies, ingest allowed `message_reaction` updates into session context, and expose an approved admin-only Telegram reaction tool.
- Phase 13 is complete for general file understanding: text, Markdown, code, CSV, TSV, and PDF documents are downloaded within safety limits, converted into bounded prompt-only context for the active run, recorded as metadata and extraction summaries, and inspectable/forgettable through `/files`.
- Phase 14 is complete for the tool permission model: every enabled tool has a runtime policy, model-exposed declarations are filtered by caller role and chat, side-effecting tool calls generate sanitized approval previews and request fingerprints, approvals bind to the latest pending request when available, and admins can inspect bounded tool audit records with `/tool audit`.
- Phase 15 is complete for read-only local repository tools: approved roots, default denied paths, safe realpath resolution, bounded file listing/reading/search, and bounded git status/branch/commit/diff tools are implemented behind admin-only read-only tool declarations.
- Phase 16 is complete for read-only GitHub integration: the host GitHub CLI is the auth boundary, admin-only model tools expose bounded repository/PR/issue/CI summaries, and `/github` commands provide concise operator status without requiring model tool use.
- Phase 17 is complete for the operator dashboard: dashboard API panels expose runtime, logs, tools, approvals, memory, and delayed restart controls with auth gating, server-side validation, bounded output, and dashboard-side secret redaction.
- Phase 18 is complete for model-assisted memory: opt-in post-run extraction stores reviewed candidates separately from approved memory, Telegram commands support candidate review and scoped memory management, and prompt construction renders only approved scoped memory.
- Phase 19 is complete for backup and log operations: local SQLite/config backups, backup validation, launchd log status, log archive/truncation, and restore guidance are implemented and tested.
- Phase 20 is complete for approved write tools: side-effect classes are explicit, real side effects require request-bound approvals, local note creation and Telegram sends are approved and scoped, and GitHub write tools remain deferred.
- Phase 21 is complete for multi-user roles and chat governance: config admins resolve as protected owners, additional owner/admin/trusted roles are stored in SQLite, per-chat policies can restrict non-operator access, commands, models, tools, memory scopes, and attachment limits, and role/policy changes are audited.
- Phase 22 is complete for local model and cost controls: operators can configure UTC daily and monthly run budgets globally and per user, chat, session, or model; budget checks run before auth and provider transport; warnings and denials are user-facing; `/usage` reports local run counts and configured limits.
- Phase 23 is complete for live validation automation: `pnpm smoke:suite` composes preflight, private conversation, command, reply, optional group mention, and optional attachment fixture checks with guarded execution and dry-run planning.
- Phase 24 is started for native non-image file support: attachment and prompt plumbing can represent native file inputs, Codex capability detection keeps file blocks disabled because the current Pi AI provider boundary supports only text and images, and the transport safely falls back to text rather than sending raw file bytes as an unsupported content type.

## Current Baseline

Verified locally on April 20, 2026:

- `corepack pnpm check` passes.
- `corepack pnpm test` passes with 64 test files and 269 tests.
- `corepack pnpm test:coverage` passes with statements 84.85%, branches 74.69%, functions 93.4%, and lines 84.76%.
- `corepack pnpm build` passes.
- `node dist/index.js health` passes against a temporary local SQLite path after build.
- `corepack pnpm smoke:preflight` passes in skipped mode when `MOTTBOT_LIVE_SMOKE_ENABLED` is unset.
- `corepack pnpm smoke:telegram-user` passes in skipped mode by default and passed live against `StartupMottBot` after the persistent service was restarted.
- `NODE_OPTIONS=--trace-deprecation corepack pnpm health` passes without the previous transitive `punycode` warning.
- The current test suite covers local state transitions, command behavior, Codex auth parsing and refresh, transport fallback, outbox behavior, and mocked run orchestration.

Current known gaps:

- Native provider attachment ingestion is limited to image inputs for models that advertise image support. Phase 24 adds native-file plumbing and guards, but the active Codex provider adapter still supports only text and images; supported non-image documents are converted into bounded prompt text rather than provider file blocks, and unsupported files remain metadata.
- Durable queue recovery is designed for one process and one SQLite database, not multiple active replicas.
- Inbound Telegram validation can be driven by the optional MTProto user smoke harness or composed live validation suite when the operator provides target chats and fixtures, but webhook delivery, OAuth, and full live Codex fault injection still require an operator-provided live environment.
- Model-executed tools include the health snapshot, admin diagnostics, admin-only local repository inspection, admin-only GitHub read inspection, and admin-only opt-in local note creation, Telegram send/reaction, and delayed restart tools. Generic network, GitHub write, and secret-adjacent model tools remain unimplemented.
- Usage budgets are local run-count controls. Billing-grade token or currency budgets remain a possible later enhancement because provider usage data can be delayed or partial.
- Multi-instance coordination is limited to a host-local SQLite lease; distributed replicas remain out of scope.

## Definition Of Complete

Mottbot is complete for the intended single-host operator use case when:

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
- Keep side-effecting tools disabled by default and expose the restart tool only to admin callers when the host opts in.

## Phase 10: Post-Baseline Backlog

These items are not required to complete the current single-host operator bot, but they should remain visible for future planning.

### Task 10.1: Multi-Instance Coordination

Status: started for host-local protection.

Deliverables:

- Document why SQLite plus in-memory queue is insufficient for multiple replicas.
- Add a host-local `app_instance_leases` guard to prevent accidental overlapping bot processes.
- Design distributed locking or external queue requirements.
- Define how session serialization would work across processes.
- Define migration and deployment changes needed for multi-instance operation.
- Keep this out of the baseline unless deployment requirements change.

### Task 10.2: Rich Long-Term Memory

Status: complete for explicit memory and deterministic automatic summaries.

Deliverables:

- Add explicit session memory records managed by `/remember`, `/memory`, and `/forget`.
- Include session memory in prompt construction as system context.
- Add tests for memory storage, memory inclusion, and command behavior.
- Add optional deterministic automatic summaries behind `MOTTBOT_AUTO_MEMORY_SUMMARIES`.
- Evaluate model-generated summaries as a later enhancement.
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

## Phase 11: Command Discovery And Conversation UX

This phase makes the bot self-documenting in Telegram before adding more powerful capabilities.

Dependencies and ordering:

- Do this before adding new file, repository, GitHub, or write-capable tools so new capabilities have a discoverable command surface from the start.
- Keep command output generated from the same capability and policy state used by the runtime; avoid hand-maintained help text that can drift.

### Task 11.1: Add Caller-Aware Help

Status: complete for the current command surface, including chat-policy-aware filtering and the `/commands` alias.

Deliverables:

- Add `/help` output that changes by caller permission, chat type, and enabled feature set.
- Keep `/help` output filtered by the same per-chat command policy used by command routing.
- Add `/commands` as a plain alias for `/help`.
- Include model/session commands, memory commands, diagnostic commands, and tool commands in separate sections.
- Hide admin-only commands from non-admin users.
- Add tests for admin private chat, non-admin private chat, and non-admin group behavior.
- Update `docs/telegram-runtime.md` and `docs/operations.md`.

### Task 11.2: Improve Tool Discovery

Status: complete for `/tool status`, `/tool help`, and `/tools`, including governed group help output that only lists tool commands the caller can actually run.

Deliverables:

- Keep `/tool status` focused on model-exposed tools, enabled host tools, and active approvals.
- Add `/tools` or `/tool help` as a shorter command discovery surface if `/tool status` becomes too dense.
- Filter `/tool help` commands through the same command policy as runtime command handling.
- Document the difference between enabled host tools and model-exposed tools.
- Add tests for side-effect tools disabled, side-effect tools enabled for admin, and non-admin visibility.

### Task 11.3: Refine User-Facing Progress Messages

Status: complete for run placeholders, tool status messages, smoke filtering, and interrupted-run recovery.

Deliverables:

- Centralized placeholder, tool-running, completion, failure, and recovery messages in a shared helper.
- Replaced the generic initial placeholder with `Starting run...`.
- Standardized restart recovery status as `Resuming queued run after restart...`.
- Kept tool status edits concise enough for Telegram and stable enough for smoke tests.
- Preserved backward compatibility for older in-flight transient text such as `Working...`.
- Prevented interrupted-run recovery from treating transient statuses as partial assistant output.
- Added tests for status formatting, live-smoke transient detection, orchestrator recovery placeholders, and outbox recovery filtering.
- Documented intentionally transient status messages in `docs/telegram-runtime.md` and `docs/tool-use-design.md`.

Validation:

- `pnpm vitest run test/shared/run-status.test.ts test/tools/telegram-user-smoke-helpers.test.ts test/runs/run-orchestrator.integration.test.ts test/telegram/outbox.integration.test.ts test/app/health.test.ts`
- `pnpm check`
- `pnpm test`
- `pnpm test:coverage`

Edge cases to cover:

- Commands with `@BotUsername` suffixes in private chats, groups, supergroups, and topics.
- Non-admin commands in groups, allowed private chats, disallowed private chats, and bound routes.
- Feature-disabled states: no diagnostics, no tool registry, side-effect tools disabled, no memory store, no auth profiles.
- Long help output that must be split into multiple Telegram messages without losing section context.
- Unknown commands that should fall through to model handling versus command-looking input that should be rejected.
- Bot restart or polling retry while a command is in progress.

Required testing:

- Unit tests for command parsing, command alias handling, and help-section filtering.
- Integration tests for admin private, admin group/topic, non-admin private, non-admin group, allowed-chat, and disallowed-chat command behavior.
- Integration tests that `/help`, `/commands`, `/tool status`, and `/tool help` reflect enabled/disabled feature state and per-chat command policy.
- Telegram formatting tests for chunked help output near Telegram message length limits.
- Live admin and temporary non-admin checks for `/help` and `/tool status`.
- Live group/topic smoke test for command suffix handling and non-admin denial behavior.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- Live `/help` and `/tool status` checks for admin and non-admin callers

## Phase 12: Telegram Reactions

This phase adds the highest-value OpenClaw-style Telegram affordance before broader Telegram UI actions: emoji reactions as status acknowledgement, context signals, and an approved model tool.

Dependencies and ordering:

- Do this after Phase 11 so reaction commands and tool visibility are discoverable.
- Keep reaction sends isolated to `src/telegram/*` and the side-effect tool handler; do not spread Bot API details into model orchestration.
- Treat model-initiated reactions as side effects requiring admin visibility and one-shot approval.

### Task 12.1: Add Reaction Configuration

Status: complete.

Deliverables:

- Add `telegram.reactions.enabled`.
- Add `telegram.reactions.ackEmoji`.
- Add `telegram.reactions.removeAckAfterReply`.
- Add `telegram.reactions.notifications` with `off`, `own`, and `all`.
- Add matching environment overrides.
- Update test config helpers and config parsing tests.

### Task 12.2: Add Ack Reactions

Status: complete.

Deliverables:

- Add a typed Telegram reaction service around `setMessageReaction`.
- Send the configured acknowledgement reaction only after a message passes command, safety, and ACL checks and is about to enter model handling.
- Keep ack failures non-fatal and token-free in logs.
- Optionally clear the bot reaction after successful or failed run completion when configured.

### Task 12.3: Add Reaction Notifications

Status: complete.

Deliverables:

- Register `message_reaction` handlers and include `message_reaction` in webhook `allowed_updates` when notification ingestion is enabled.
- Normalize added and removed emoji reactions into internal reaction events.
- Support `own` mode by accepting reactions only on known bot-authored messages.
- Support `all` mode for allowed chats.
- Persist reaction notifications as `system` transcript entries so the next model turn can see them as context.
- Document the Telegram limitation that reaction updates do not carry topic thread IDs.

### Task 12.4: Add Approved Reaction Tool

Status: complete.

Deliverables:

- Add `mottbot_telegram_react` as an admin-only side-effecting model tool.
- Require the existing one-shot approval flow before the tool can add or clear a reaction.
- Validate chat ID, message ID, emoji, and optional large-reaction flag.
- Return a bounded JSON tool result without logging credentials or raw auth data.

Edge cases covered:

- Empty emoji clears the bot reaction.
- Ack reaction API failures do not prevent the model run from starting.
- Reaction update duplicates are processed through durable update dedupe.
- `own` notification mode ignores reactions on messages not sent by the bot.
- Webhook mode requests `message_reaction` updates only when reaction notifications are enabled.
- Reaction cleanup after reply is opt-in because Telegram clears the bot's reactions on that message.

Required testing:

- Unit tests for reaction service send/clear behavior.
- Unit tests for reaction update normalization and notification formatting.
- Integration tests for ack reaction sends on accepted model-bound messages.
- Integration tests for `message_reaction` ingestion and `own` filtering.
- Integration tests for webhook `allowed_updates` registration.
- Tool tests for approved admin reaction calls, approval consumption, and Bot API handler arguments.
- Full `pnpm check`, `pnpm test`, `pnpm test:coverage`, and `pnpm build`.
- Live Telegram smoke that sends a normal message and verifies the bot still completes after ack reaction handling.

Verification:

- `corepack pnpm vitest run test/app/config.test.ts test/telegram/reactions.test.ts test/telegram/bot.test.ts test/tools/registry.test.ts test/tools/executor.test.ts test/runs/run-orchestrator.integration.test.ts`
- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- `corepack pnpm build`

## Phase 13: General File Understanding

This phase expands attachment support beyond images and metadata while keeping raw files out of committed and long-lived storage.

Dependencies and ordering:

- Do this before repository tools, because the same extraction, truncation, and prompt-rendering patterns should be reused for local files later.
- Do not add write-capable file operations in this phase.

### Task 13.1: Add Text And Markdown File Ingestion

Status: complete.

Deliverables:

- Detect Telegram text-like documents by MIME type, extension, and safe byte inspection.
- Enforce per-file and total text extraction limits.
- Convert extracted text into prompt-safe attachment context.
- Persist metadata and extraction summary without storing raw file contents in SQLite.
- Add tests for UTF-8 text, Markdown, oversized files, and unsupported encodings.

### Task 13.2: Add PDF Text Extraction

Status: complete.

Deliverables:

- Choose a maintained PDF text extraction library compatible with the current Node version.
- Extract bounded text from PDFs without executing embedded content.
- Return a clear Telegram message when a PDF is encrypted, scanned, too large, or unreadable.
- Add tests using small fixture PDFs and failure fixtures.
- Document the extraction limitations.

### Task 13.3: Add Code And CSV Summaries

Status: complete.

Deliverables:

- Recognize common code file extensions and preserve filename/language metadata.
- Recognize CSV/TSV files and include bounded table previews.
- Avoid loading large files fully into memory when streaming or chunking is available.
- Add tests for code files, CSV headers, long rows, and truncation behavior.

### Task 13.4: Add File-Oriented Commands

Status: complete.

Deliverables:

- Add `/files` or equivalent to list recent attachment metadata for the current session.
- Add a way to forget or clear retained attachment metadata without touching unrelated transcripts.
- Add retention-pruning integration with attachment metadata.
- Update data-model and operations docs.

Edge cases to cover:

- Telegram documents with missing filename, missing MIME type, misleading extension, or incorrect size metadata.
- Files that exceed metadata size limits before download and files that exceed byte limits during download.
- UTF-8 with BOM, invalid UTF-8, very long lines, null bytes, binary files with text-like extensions, and compressed files.
- PDFs that are encrypted, image-only/scanned, malformed, huge, password-protected, or contain no extractable text.
- CSV/TSV files with quoted newlines, very wide rows, missing headers, inconsistent columns, and formula-like cells.
- Multiple attachments in one message where some succeed and some fail.
- Cleanup after successful prompt construction, cleanup after model failure, cleanup after Telegram download failure, and missing cache files.
- User-visible output must not include local cache paths, raw file bytes, or internal Telegram file URLs.

Required testing:

- Unit tests for MIME/extension classification and byte-limit enforcement.
- Unit tests with fixtures for UTF-8 text, Markdown, invalid encoding, binary masquerading as text, CSV, TSV, code files, and representative PDFs.
- Integration tests for Telegram attachment metadata through transcript persistence and prompt rendering.
- Cleanup tests for success, failure, partial failure, reset, and retention pruning.
- Safety tests proving local file paths, raw bytes, and Telegram file URLs are not exposed in Telegram replies or transcript text.
- Load tests with max attachment count, max total size, and truncation boundaries.
- Live smoke tests with text, Markdown, PDF, code, CSV, unsupported binary, mixed attachments, and image messages.

Verification:

- `corepack pnpm vitest run test/telegram/file-extraction.test.ts test/telegram/attachments.test.ts test/runs/helpers.test.ts test/runs/prompt-builder.test.ts test/runs/run-orchestrator.integration.test.ts test/telegram/commands.integration.test.ts test/db/migrate.test.ts test/db/retention.test.ts test/app/config.test.ts`
- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Live smoke tests with a text file, PDF fixture, code file, CSV, and image

## Phase 14: Tool Permission Model

Status: complete.

This phase strengthens the approval layer before adding broader tools.

Dependencies and ordering:

- Complete this before Phase 15 repository tools if any new tool might read outside existing runtime diagnostics.
- Complete this before Phase 20 write-capable tools; approval previews and audit inspection are prerequisites for writes.

### Task 14.1: Add Per-Tool Policy

Deliverables:

- Define a policy shape for each tool: allowed roles, allowed chats, required approval, dry-run availability, and maximum output.
- Keep policy loading in app/config or a dedicated tool policy module.
- Preserve deny-by-default behavior when policy is absent.
- Add tests for policy parsing, policy defaults, and denied execution.

Implemented notes:

- `MOTTBOT_TOOL_POLICIES_JSON` and `tools.policies` provide operator overrides for enabled tools.
- Admin-only tools remain admin-only even if an override attempts to expose them to normal users.
- Model tool declarations are filtered before each run by caller role and chat.
- Execution rechecks policy immediately before running a tool.

### Task 14.2: Add Approval Previews

Deliverables:

- Generate a human-readable approval preview before any side-effecting tool can execute.
- Include target resource, action, bounded arguments, and expected side effect.
- Avoid including secrets or raw auth payloads in previews.
- Add tests for preview rendering and preview omission of sensitive fields.

Implemented notes:

- Approval previews redact sensitive argument keys such as token, secret, password, API key, credential, bearer, authorization, and hash.
- Side-effect approvals store a stable request fingerprint when approved from the latest pending request, preventing reuse for different arguments.
- Dry-run policy mode returns a preview without calling the side-effect handler.

### Task 14.3: Add Tool Audit Inspection

Deliverables:

- Add admin command output for recent tool approvals and tool audit decisions.
- Add filters by session, tool name, and decision code.
- Keep audit output bounded and token-free.
- Add tests for successful, denied, expired, and consumed approval records.

Implemented notes:

- `/tool audit [limit] [here] [tool:<name>] [code:<decision>]` lists bounded audit rows for admins.
- Audit rows retain decision code, side-effect class, optional run/session, request fingerprint prefix, and sanitized preview text.

Edge cases to cover:

- Missing policy, malformed policy, policy that names unknown tools, and policy that enables disabled tools.
- Admin-only tools requested by non-admin callers through model tool calls and Telegram commands.
- Approval race conditions: double approval, revoke during execution, expired approval, consumed approval reused, and concurrent runs in the same session.
- Approval mismatch by tool name, session key, side-effect class, target resource, or bounded arguments.
- Policy changes while approvals are active.
- Audit output containing long arguments, potentially sensitive argument names, or large tool outputs.
- Dry-run tools that return previews but must not execute side effects.

Required testing:

- Unit tests for policy parsing, defaults, deny-by-default behavior, and config-file/env precedence.
- Unit tests for approval preview rendering and sensitive-field redaction.
- Integration tests for registry declaration filtering by role, chat, and side-effect class.
- Integration tests for approval lifecycle: requested, approved, denied, expired, revoked, consumed, and replay-denied.
- Database tests for audit persistence, query filters, retention, and migration compatibility.
- Live admin approval/revoke/status test and live non-admin denial test.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Live approval/revoke/status test in a private admin chat

## Phase 15: Read-Only Local Repository Tools

This phase gives the model safe visibility into the local project without write access.

Status: complete.

Dependencies and ordering:

- Requires Phase 14 policy controls.
- Should precede GitHub read integration so local source inspection and git summaries are stable before remote context is added.

### Task 15.1: Define Repository Read Scope

Deliverables:

- Add config for approved repository roots and ignored paths.
- Deny access to `.env`, SQLite files, auth files, session files, logs, and generated output by default.
- Resolve paths safely and reject traversal outside approved roots.
- Add tests for allowed files, denied files, symlinks, traversal, and generated-output paths.

Implemented notes:

- `tools.repository` and the `MOTTBOT_REPOSITORY_*` environment variables configure approved roots, extra denied paths, read/search limits, and command timeout.
- Default denied paths include `.env`, `.env.*`, `mottbot.config.json`, `auth.json`, `.codex`, `.git`, `node_modules`, `data`, `dist`, `coverage`, database files, logs, and Telegram session files.
- Repository paths are resolved through `realpath` and rejected when traversal or symlinks escape the approved root.

### Task 15.2: Add File Search And Read Tools

Deliverables:

- Add read-only tools for listing files, reading bounded file slices, and searching with `rg`.
- Enforce byte, line, and timeout limits.
- Return structured results with path, line numbers, truncation, and match counts.
- Add tests for successful search, no matches, binary files, and timeout behavior.

Implemented notes:

- `mottbot_repo_list_files`, `mottbot_repo_read_file`, and `mottbot_repo_search` are admin-only read-only tools.
- Search prefers `rg --json --fixed-strings` and falls back to a bounded Node search when `rg` is unavailable.
- Binary reads are rejected using a null-byte sample check.

### Task 15.3: Add Git Read Tools

Deliverables:

- Add read-only tools for status, recent commits, branch name, diff summary, and selected file diff.
- Sanitize output and avoid leaking ignored or untracked secret file contents.
- Add tests with a temporary git repository fixture.
- Document which git commands are used and why they are read-only.

Implemented notes:

- `mottbot_git_status`, `mottbot_git_branch`, `mottbot_git_recent_commits`, and `mottbot_git_diff` are admin-only read-only tools.
- Git status output filters denied paths before returning text.
- `mottbot_git_branch` returns the current branch or a detached commit marker.
- `mottbot_git_diff` returns a stat/summary when no path is provided and a bounded selected-file diff when the path is allowed.

Edge cases to cover:

- Path traversal with `..`, absolute paths, URL-encoded paths, symlinks, hard links, nested repos, and case-insensitive path collisions on macOS.
- Denied files: `.env`, auth files, Telegram user session files, SQLite files, WAL/SHM files, logs, `data/`, `dist/`, `coverage/`, and ignored generated output.
- Huge files, binary files, files with invalid UTF-8, long lines, and files changed or deleted between listing and reading.
- `rg` unavailable, `rg` timeout, no matches, too many matches, and matches in denied paths.
- Git repository absent, detached HEAD, unborn branch, dirty worktree, submodules, large diffs, binary diffs, renamed files, and untracked ignored files.
- Tool outputs that could leak secret-looking strings from tracked files; decide whether to redact or rely on approved roots and denied paths.

Required testing:

- Unit tests for approved-root resolution, denied-path matching, symlink handling, traversal rejection, and generated-output rejection.
- Unit tests for output truncation by bytes, lines, match count, and timeout.
- Integration tests using temporary repositories for clean, dirty, detached, no-git, submodule, rename, binary-diff, and large-diff states.
- Tool executor tests proving repository tools stay read-only and respect policy.
- Regression tests proving secret-adjacent files are denied even when explicitly requested by the model.
- Live admin prompt asking for repo status, bounded file read, search with matches, and search with no matches.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Live admin prompt asking for local repo status and a bounded file search

## Phase 16: GitHub Read Integration

This phase adds GitHub awareness without write permissions.

Dependencies and ordering:

- Requires Phase 14 policy controls.
- Prefer after Phase 15 so local and remote repository views can share output shaping and permission conventions.

### Task 16.1: Add GitHub Configuration And Auth Boundaries

Deliverables:

- Decide whether the integration uses GitHub CLI, GitHub app connector, or a token-backed API path.
- Document required permissions and token storage.
- Keep GitHub credentials out of logs, Telegram output, and transcripts.
- Add tests for missing auth, unavailable CLI/API, and configured repository resolution.

Implemented notes:

- The runtime uses host `gh` auth; Mottbot stores no GitHub tokens.
- The default repository comes from `MOTTBOT_GITHUB_REPOSITORY` or local `origin`.
- CLI errors and GitHub response strings are sanitized before returning.

### Task 16.2: Add Read-Only GitHub Tools

Deliverables:

- Add tools for repository metadata, open PRs, recent issues, CI status, and recent workflow failures.
- Keep output bounded and link-rich.
- Add tests for mocked API responses and failure shapes.
- Document rate-limit behavior and fallback messages.

Implemented notes:

- Admin-only read tools cover repository metadata, open pull requests, recent issues, CI status, and failed workflows.
- Outputs are structured, bounded, link-rich, and covered by mocked command-runner tests.

### Task 16.3: Add Telegram Commands For GitHub Status

Deliverables:

- Add admin commands for concise repository and CI status.
- Avoid making GitHub command behavior depend on model tool use.
- Add tests for command output and missing integration configuration.

Implemented notes:

- `/github` and `/gh` expose the same read service directly for admins.

Edge cases to cover:

- Missing auth, expired auth, insufficient scopes, inaccessible repository, renamed repository, archived repository, forked repository, and private repository access denial.
- API rate limits, abuse limits, network timeouts, GitHub downtime, malformed API responses, and pagination.
- CI with multiple workflow runs, cancelled runs, skipped jobs, reruns, matrix failures, and checks from multiple providers.
- Pull requests from forks, draft PRs, merge conflicts, deleted branches, and huge diffs that must stay summarized.
- GitHub data containing secrets or user-generated content that should be bounded before sending to Telegram.
- Connector/CLI mismatch if both GitHub CLI and app integration are available.

Required testing:

- Unit tests for GitHub config parsing and repository identifier normalization.
- Mocked API/client tests for auth failure, missing repository, rate limit, pagination, empty results, and malformed responses.
- Tool tests for PR list, issue list, CI status, workflow failure summary, and repository metadata outputs.
- Telegram command integration tests for configured, unconfigured, and auth-failed states.
- Redaction tests ensuring tokens, auth headers, and raw API payloads are never logged or persisted.
- Optional live read-only validation against the configured repository, including one CI-status request.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- Mocked GitHub integration tests
- Optional live read-only validation against the configured repository

## Phase 17: Operator Dashboard

This phase turns the existing dashboard into the operational control panel.

Dependencies and ordering:

- Can start after Phase 11, but dashboard tool and memory panels should track the policy/memory state available at the time.
- Do not expose dashboard beyond loopback until auth, CSRF posture, and secret redaction are re-reviewed.

### Task 17.1: Add Runtime Panels

Deliverables:

- Show health counters, service state, current process ID, active runs, queued runs, and stale outbox counters.
- Show recent runs, recent errors, and recent log excerpts with bounded output.
- Keep secrets and raw prompts out of dashboard output by default.
- Add API tests for each panel endpoint.

Implemented notes:

- `/api/dashboard/runtime` returns health, service status, process metadata, recent runs, and recent failed runs.
- `/api/dashboard/logs` returns bounded stdout/stderr excerpts with secret-like text redacted.

### Task 17.2: Add Tool And Memory Panels

Deliverables:

- Show enabled tools, model-exposed tools by role, active approvals, and recent audit decisions.
- Show session memory with edit/delete controls behind dashboard auth.
- Validate all dashboard mutations server-side.
- Add tests for auth, validation, and redaction.

Implemented notes:

- `/api/dashboard/tools` returns enabled tools, model-exposed tool names by role, active approvals, and recent audit rows.
- `/api/dashboard/memory` supports session-scoped listing, adding, editing, and deleting with server-side validation.

### Task 17.3: Add Safe Service Controls

Deliverables:

- Add restart, health refresh, and log refresh controls.
- Require dashboard auth token and loopback binding unless explicitly configured otherwise.
- Add confirmation for process-control actions.
- Add tests for authorized and unauthorized dashboard actions.

Implemented notes:

- `/api/dashboard/service/restart` requires a configured dashboard auth token, a valid token on the request, and a `restart` confirmation before scheduling the existing delayed launchd restart path.

Edge cases to cover:

- Dashboard disabled, missing auth token, non-loopback bind without auth token, wrong auth token, and stale browser tabs after config changes.
- Concurrent dashboard mutations, service restart while dashboard request is active, and database locked errors.
- Large logs, log files missing after rotation, unreadable logs, and old archive files.
- Sessions or runs deleted by retention while dashboard is rendering.
- Memory entries or tool arguments containing long text, Markdown, HTML-like text, or secret-looking values.
- Browser refresh during restart and partial API failures where some panels load and others fail.

Required testing:

- API tests for every new dashboard endpoint with authorized, unauthorized, disabled, and validation-failed requests.
- Redaction tests for config, logs, memory, tool arguments, and run summaries.
- Concurrency tests for simultaneous config writes or restart requests where practical.
- Snapshot or DOM-level tests for panel rendering if the dashboard grows enough to justify them.
- Manual loopback dashboard smoke test for health, logs, approvals, memory, and restart confirmation.
- Non-loopback config test proving auth-token guard remains enforced.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- Dashboard endpoint tests
- Manual local dashboard smoke test

## Phase 18: Model-Assisted Memory

This phase upgrades memory from deterministic summaries to model-assisted recall with review controls.

Status: complete for opt-in model candidate extraction, candidate review commands, scoped approved memory, prompt ordering, migrations, and tests.

Dependencies and ordering:

- Best after Phase 11 so memory review commands are discoverable.
- Best after Phase 14 if memory extraction or review uses tools or policy decisions.

### Task 18.1: Add Memory Candidate Extraction

Deliverables:

- Ask the model to propose memory candidates after eligible conversations.
- Store candidates separately from accepted memories.
- Include reason, source message IDs, sensitivity class, and proposed scope.
- Add tests with mocked model outputs and malformed candidate payloads.

Implemented:

- `MOTTBOT_MEMORY_CANDIDATES_ENABLED=true` enables post-run extraction using the configured model.
- Candidate output is parsed as strict JSON, deduplicated, sensitivity-upgraded for secret-like text, and ignored on malformed output without failing the completed run.

### Task 18.2: Add Memory Review Workflow

Deliverables:

- Add Telegram commands to review, accept, reject, edit, pin, archive, and clear memory candidates.
- Require explicit user/admin approval before storing sensitive or long-lived facts.
- Add tests for candidate lifecycle and permission boundaries.

Implemented:

- `/memory candidates`, `/memory accept`, `/memory reject`, `/memory edit`, `/memory archive candidate`, and `/memory clear candidates` manage the review queue.
- `/memory pin`, `/memory unpin`, and `/memory archive` manage approved memory.
- Group command restrictions continue to require configured admins for review commands.

### Task 18.3: Add Memory Scopes

Deliverables:

- Support personal, chat, group, and project memory scopes.
- Define precedence and prompt rendering order.
- Add migration and data-model docs for scoped memories.
- Add tests for prompt inclusion and isolation across sessions.

Implemented:

- `session`, `personal`, `chat`, `group`, and explicit `project:<key>` scopes are supported.
- Prompt order is pinned memory first, then project, personal, group, chat, session, and automatic summaries.

Edge cases to cover:

- Model proposes false, sensitive, private, stale, contradictory, duplicate, or overly broad memories.
- Prompt injection attempts that ask the bot to store secrets or ignore review policy.
- Memories from group chats that should not leak into private chats or other groups.
- User deletes or edits a memory while a run is building its prompt.
- Automatic summaries conflict with explicit pinned memories.
- Very long memory candidates, non-English text, code snippets, and personally identifying information.
- Memory review commands from non-admin users in group chats and from users who are not the memory owner.

Required testing:

- Unit tests for candidate schema validation, deduplication, sensitivity classification, scope resolution, and prompt ordering.
- Mocked model tests for malformed JSON, empty candidates, duplicate candidates, and adversarial candidate text.
- Store/migration tests for candidate lifecycle, accepted memory, archived memory, pinned memory, and scoped memory isolation.
- Command integration tests for review, accept, reject, edit, pin, archive, forget, and permission denial.
- Prompt-builder tests proving the right memories appear for personal, chat, group, and project scopes.
- Live smoke test for candidate review in a private admin chat and a group isolation test.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Live memory review smoke test

## Phase 19: Backup, Log Rotation, And Recovery Hardening

This phase turns operational hygiene into repeatable commands.

Status: complete for local backup creation, backup validation, restore dry-run warnings, log status, log archive/truncation, retention pruning, docs, and tests.

Dependencies and ordering:

- Can be implemented at any time, but should happen before the bot stores more high-value memories, files, or role policy.
- Backup commands must remain local and avoid Telegram-triggered destructive behavior unless a later approved write policy explicitly allows it.

### Task 19.1: Add Backup Command

Deliverables:

- Add a CLI command that creates a timestamped backup of SQLite, WAL/SHM files when present, config, and non-secret operational metadata.
- Exclude `.env` by default unless explicitly requested with a warning.
- Add integrity checks for backup files.
- Add tests using a temporary SQLite database.

Implemented:

- `mottbot backup create [--dest <dir>] [--include-env]` writes a manifest, consistent SQLite backup, optional source sidecars, and redacted config.
- `manifest.json` records sizes and SHA-256 checksums; the backup database is checked with `pragma integrity_check`.

### Task 19.2: Add Restore Runbook And Dry Run

Deliverables:

- Document restore steps for launchd downtime, file placement, permissions, and migration checks.
- Add a dry-run restore validator if practical.
- Add tests for validator behavior.

Implemented:

- `mottbot backup validate <backup-dir> [--target-sqlite <path>]` verifies manifest checksums and SQLite integrity, warns when `.env` is absent, and warns if the target database already exists.

### Task 19.3: Add Log Rotation Policy

Deliverables:

- Add CLI or service guidance for log archive, truncation, and retention.
- Keep log rotation separate from committed output.
- Add health or diagnostic visibility into log file size.
- Update `SETUP.md` and `docs/operations.md`.

Implemented:

- `mottbot logs status` reports launchd log paths and sizes.
- `mottbot logs rotate [--archive-dir <dir>] [--truncate] [--max-archives <count>]` archives logs, optionally truncates active files, skips missing files/symlinks, and prunes old archives.
- `/debug logs` diagnostics include log sizes in section headers.

Edge cases to cover:

- SQLite database in WAL mode, active writer during backup, missing WAL/SHM files, locked database, corrupted database, and insufficient disk space.
- Backup destination already exists, backup directory missing, permission errors, cross-device moves, and interrupted backup.
- `.env` excluded by default, explicitly included only with warning, and never printed.
- Restore onto an existing database, wrong file permissions, wrong owner, mismatched master key, and pending migrations after restore.
- Logs missing, huge, unreadable, rotated externally, or symlinked.
- Launchd service running during restore when it should be stopped.

Required testing:

- Unit tests for backup path generation, inclusion/exclusion rules, and retention pruning.
- Integration tests against temporary SQLite databases with WAL/SHM files.
- Failure tests for locked database, unwritable destination, missing files, and interrupted archive creation where practical.
- Restore validator tests for good backup, missing files, wrong permissions, and migration-needed states.
- Log rotation tests for archive naming, truncation, missing logs, large logs, and retention cleanup.
- Manual runbook smoke test: stop service, backup, validate backup, restart service, and confirm health.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- Backup/restore dry-run test on a temporary database
- Manual log-rotation smoke test

## Phase 20: Write-Capable Approved Tools

This phase adds useful side effects only after policy and audit controls are ready.

Status: complete for side-effect class separation, mandatory approval for real side effects, local create-only note writes, approved Telegram plain-text sends, config, docs, and tests. GitHub write tools remain deferred.

Dependencies and ordering:

- Requires Phase 14.
- GitHub write tools should wait for Phase 16.
- Telegram-send and local-write tools should start with disposable or explicitly approved targets only.

### Task 20.1: Define Write Tool Classes

Deliverables:

- Separate local-write, network-write, Telegram-send, GitHub-write, and process-control tool classes.
- Require policy, approval preview, audit record, and bounded output for every write-capable tool.
- Keep write tools disabled by default.
- Add registry tests for each side-effect class.

Implemented:

- Tool side-effect classes now include `local_write`, `network_write`, `telegram_send`, `github_write`, `process_control`, and `secret_adjacent`.
- Real side-effect execution always requires a one-shot approval; `dryRun:true` remains the preview-only path.
- Runtime registry keeps all write-capable tools disabled until `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=true`.
- Tests cover registry exposure and class-specific approval previews.

### Task 20.2: Add Low-Risk Write Tools

Deliverables:

- Start with tightly scoped operations such as creating draft notes in an approved local directory or sending a message to an approved Telegram chat.
- Require explicit approval with target preview.
- Add rollback or manual cleanup guidance where possible.
- Add integration tests for approval, execution, denial, and audit persistence.

Implemented:

- `mottbot_local_note_create` creates only new `.md` or `.txt` files under `tools.localWrite` roots, denies traversal/symlink escapes, refuses overwrite, enforces byte limits, and returns cleanup guidance without echoing content.
- `mottbot_telegram_send_message` sends plain text to the current chat or configured approved targets only; target and text are included in the approval fingerprint.
- `MOTTBOT_LOCAL_WRITE_*` and `MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS` configure approved write targets.
- Tests cover create-only writes, denied paths, oversized writes, target-bound Telegram sends, approval mismatch, one-shot approval consumption, duplicate-call denial, and audit persistence.

### Task 20.3: Add GitHub Write Tools Later

Deliverables:

- Add issue creation, draft PR description creation, and comment drafting only after read-only GitHub integration is stable.
- Keep all writes admin-only and approval-gated.
- Add tests with mocked API clients and no live writes by default.
- Document live-write validation procedure.

Status: deferred. The `github_write` side-effect class exists, but no GitHub write handler is exposed yet.

Edge cases to cover:

- Approval preview differs from final execution arguments, target changes after approval, approval expires mid-run, and duplicate model tool calls.
- Write target unavailable, permission denied, file already exists, race with existing file, network timeout, partial write, and idempotency retry.
- Telegram send target not approved, blocked bot, deleted chat, topic unavailable, or message too long.
- GitHub issue/PR/comment creation against wrong repo, archived repo, fork permissions, rate limit, duplicate submit, and API validation error.
- User cancels or revokes approval while execution is queued.
- Tool output includes created resource links but not raw request bodies or credentials.

Required testing:

- Unit tests for write policy, preview generation, idempotency keys, and argument/target matching.
- Integration tests for approval, execute, deny, revoke, expire, duplicate-call, and audit persistence.
- Mocked file-write tests for create-only, overwrite-denied, path traversal, permission error, and cleanup guidance.
- Mocked Telegram-send tests for approved target, unapproved target, too-long message, and Telegram API failure.
- Mocked GitHub-write tests for issue creation, comment drafting, validation error, rate limit, and auth failure.
- Live tests only against disposable local directories, disposable Telegram chats, and disposable GitHub test repositories.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Live test only against disposable targets

## Phase 21: Multi-User Roles And Chat Governance

This phase makes the bot safe for more than one trusted operator.

Status: complete for persistent roles, per-chat policy enforcement, Telegram governance commands, audit records, tests, and docs.

Dependencies and ordering:

- Should happen before broad non-owner rollout.
- Cost controls in Phase 22 should build on these role and chat policies.

### Task 21.1: Add Role Model

Status: complete.

Deliverables:

- Define owner, admin, trusted user, and normal user roles.
- Decide whether roles live in config, SQLite, or both.
- Add migration and store APIs if roles become persistent.
- Add tests for role lookup and defaults.

Implemented:

- `telegram.adminUserIds` resolve as protected `owner` roles.
- Database-backed roles support `owner`, `admin`, and `trusted`; unknown users resolve as `user`.
- Last-owner protection prevents deleting the only owner when no config owner exists.
- Tool caller roles now include owner/admin/trusted/user, with owner/admin treated as operator roles.

### Task 21.2: Add Per-Chat Policy

Status: complete.

Deliverables:

- Configure allowed models, tools, memory scopes, attachment limits, and command permissions per chat or session.
- Keep current single-owner behavior as the default.
- Add tests for private chat, group, topic, and allowed-chat interactions.

Implemented:

- Chat policy supports `allowedRoles`, `commandRoles`, `modelRefs`, `toolNames`, `memoryScopes`, `attachmentMaxFileBytes`, and `attachmentMaxPerMessage`.
- ACL and command authorization enforce chat role policy for non-operators.
- Non-operator group commands require an explicit chat policy command allow-list.
- `/model`, `/remember`, memory candidate acceptance, model tool declaration filtering, and tool execution all recheck the relevant chat policy.

### Task 21.3: Add Invite And Audit Workflows

Status: complete.

Deliverables:

- Add admin commands to list users, grant roles, revoke roles, and inspect recent user actions.
- Add audit records for role changes.
- Add tests for unauthorized role changes and audit output.

Implemented:

- `/users me`, `/users list`, `/users grant`, `/users revoke`, `/users audit`, and `/users chat show|set|clear` manage role and chat governance.
- Role grants, revokes, chat policy writes, and chat policy clears append governance audit records.
- Owner-only mutation commands and owner/admin read commands are covered by command integration tests.

Edge cases to cover:

- User has no Telegram username, username changes, numeric user ID reused only as string, and forwarded messages where sender identity differs.
- Owner accidentally revokes own owner role, last owner removal, duplicate grants, stale role cache, and role changes during active runs.
- Group admins who are not bot admins, topic-specific policy, bound route policy, and allowed-chat policy conflicts.
- User leaves group, bot is removed from group, chat migrates to supergroup, and Telegram chat ID changes.
- Policy conflict between global role, per-chat policy, per-session model, and tool policy.
- Audit output requested by non-admin or by a user whose role was just revoked.

Required testing:

- Unit tests for role resolution, config/database precedence, last-owner protection, and policy merge order.
- Migration/store tests for persistent role and chat-policy tables if added.
- Command tests for grant, revoke, list, inspect, unauthorized changes, duplicate changes, and audit output.
- Permission matrix tests across owner, admin, trusted user, normal user, unknown user, private chat, group, supergroup, topic, and allowed/disallowed chat.
- Run orchestration tests proving role changes affect new runs without corrupting active runs.
- Live validation with at least one non-owner Telegram user and one group/topic environment.

Verification:

- `corepack pnpm check`
- `corepack pnpm vitest run test/tools/policy.test.ts test/tools/executor.test.ts test/telegram/governance.test.ts test/telegram/commands.integration.test.ts test/telegram/acl.test.ts test/db/migrate.test.ts test/runs/run-orchestrator.integration.test.ts`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- Permission matrix tests across roles and chat types
- Live validation with at least one non-owner test user remains recommended before broad rollout

## Phase 22: Model And Cost Controls

This phase bounds usage as the bot becomes more capable and multi-user.

Status: complete for host-local run-count budgets, warning/denial handling, chat/model policy reuse, `/usage` reporting, configuration docs, and tests. Currency-grade cost accounting is intentionally not treated as authoritative because subscription-provider usage payloads can be unavailable, delayed, or partial.

Dependencies and ordering:

- Should follow Phase 21 so budgets and model policy can be assigned by role and chat.
- Should not depend on provider usage data being complete; local counters must degrade gracefully.

### Task 22.1: Add Usage Budgets

Deliverables:

- Track usage by session, chat, user, model, and time window where provider data allows it.
- Add configurable daily and monthly run caps.
- Add warning thresholds and user-facing denial messages.
- Add tests for cap enforcement and reset windows.

### Task 22.2: Add Model Policy

Deliverables:

- Configure allowed models by role and chat.
- Reuse Phase 21 chat policy to restrict allowed model refs by chat.
- Keep default cheap-mode or fast-mode policy optional; no implicit model downgrade is applied today.
- Add tests for denied model changes and allowed chat-scoped model changes.

### Task 22.3: Add Operator Reporting

Deliverables:

- Add `/usage` reporting for recent local run usage and configured limits.
- Keep account IDs and tokens out of output.
- Add tests for reporting output and invalid command input.

Edge cases to cover:

- Provider usage unavailable, delayed, partial, reset time missing, multiple usage windows, and transport reports usage differently. The implemented budget path uses local run counters so these cases do not block enforcement.
- Runs that fail before model request, fail after stream starts, are cancelled, or execute tools without final text. Local caps intentionally count accepted non-budget-denied runs as pressure against abuse, and exclude only prior `usage_budget_denied` rows.
- Budget reset across time zones, daylight saving changes, clock skew, and process restart. Implemented windows use UTC day/month boundaries and persisted run rows.
- Multiple users share one chat, one user uses multiple chats, and one session changes model mid-window.
- Non-admin attempts to select expensive models or bypass caps with `/model`, `/fast`, retries, attachments, or group routes.
- Reporting output too long for Telegram and dashboard charts with sparse or missing data.

Required testing:

- Unit tests for usage aggregation, budget windows, reset calculations, and local fallback counters.
- Store tests for persisted usage by run, user, chat, session, model, and time window.
- Command tests for `/usage`, budget warnings, cap denial, model-policy denial, and admin override if supported.
- Integration tests for completed, failed, cancelled, tool-using, attachment-using, and retried runs where budget behavior is affected.
- Time-control tests for reset boundaries and process restart.
- Mocked provider tests for missing, partial, delayed, and malformed usage data remain relevant to `/status`; `/usage` does not depend on provider usage payloads.
- Optional live smoke test for usage reporting after a real model run.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- `corepack pnpm build`
- Mocked usage-window tests
- Optional live usage reporting smoke test

## Phase 23: Live Validation Automation

This phase makes the live validation workflow repeatable without requiring the operator to manually assemble one-off commands for every check.

Status: complete for a guarded suite runner, dry-run plan output, preflight composition, MTProto private-chat command/conversation checks, reply-to-latest-bot-message checks, optional group mention checks, optional attachment fixture checks, docs, and helper tests. Public webhook delivery automation and live Codex fault injection remain later hardening work.

Dependencies and ordering:

- Follows Phase 6 and Phase 7 because it composes the existing guarded preflight and host-local runtime scripts.
- Follows Phase 13, Phase 21, and Phase 22 so attachment, group governance, and `/usage` scenarios are meaningful.

### Task 23.1: Add Suite Runner

Deliverables:

- Add a `pnpm smoke:suite` script.
- Require `MOTTBOT_LIVE_VALIDATION_ENABLED=true` before any live action.
- Add dry-run output through `MOTTBOT_LIVE_VALIDATION_DRY_RUN=true`.
- Print token-free JSON summaries with scenario status, skipped checks, and bounded child output.

### Task 23.2: Compose Existing Smoke Harnesses

Deliverables:

- Always include guarded live preflight.
- Reuse the MTProto user-account harness for private conversation, `/health`, `/usage`, and reply checks when Telegram API credentials are configured.
- Add optional group mention and attachment fixture scenarios.
- Allow `MOTTBOT_LIVE_VALIDATION_SCENARIOS` to filter the matrix.

### Task 23.3: Document Operator Workflow

Deliverables:

- Update `docs/live-smoke-tests.md`, `SETUP.md`, `docs/operations.md`, and `docs/testing.md`.
- Add `.env.example` entries for live validation suite flags.
- Document which checks remain manual or environment-dependent.

Edge cases to cover:

- Guard unset, dry-run mode, and scenario filters.
- User-account credentials missing by default versus required by policy.
- Group target omitted, fixture paths omitted, and multiple fixture paths.
- Bounded output and token-free summaries when child scripts fail.
- Reusing an existing Telegram user session versus first-run interactive login.

Required testing:

- Unit tests for plan generation, scenario filtering, required credential handling, group scenarios, and file scenarios.
- Typecheck for the suite runner.
- Skipped-mode smoke execution without live secrets.
- Dry-run execution without live secrets.

Verification:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- `corepack pnpm build`
- `corepack pnpm smoke:suite`
- `MOTTBOT_LIVE_VALIDATION_ENABLED=true MOTTBOT_LIVE_VALIDATION_DRY_RUN=true corepack pnpm smoke:suite`

## Phase 24: Native Non-Image Provider File Blocks

This phase moves beyond prompt-only non-image document handling when the provider adapter exposes a real file content type.

Status: started. Mottbot now has typed native file attachment plumbing, model capability detection for native file input, and a Codex transport fallback that never passes raw file bytes through the current text/image-only Pi AI boundary. The active Codex model capability still reports native file input as unsupported, so runtime behavior remains prompt-text extraction for supported documents.

Dependencies and ordering:

- Follows Phase 13 because text extraction and metadata retention are the fallback path.
- Follows Phase 23 so attachment fixture smoke checks can validate any future provider-native file path.
- Requires a provider adapter content type that can represent non-image files without treating them as images.

### Task 24.1: Add Native File Plumbing

Deliverables:

- Extend internal native attachment inputs with a file variant.
- Extend prompt content blocks with a file variant.
- Pass a separate native file capability from model capabilities into attachment preparation.
- Add tests proving native file preparation is capability-gated.

### Task 24.2: Guard The Current Provider Boundary

Deliverables:

- Report native file input as unsupported for the current `openai-codex` Pi AI provider boundary.
- Ensure accidental file blocks are rendered as a safe text fallback rather than passed as image blocks.
- Add tests proving raw file bytes are not sent through the current provider context.

### Task 24.3: Enable Provider-Native Files When Available

Deliverables:

- Add a provider content conversion for real non-image file blocks once the provider adapter supports them.
- Restrict enabled file MIME types and size limits to the provider-supported set.
- Add live smoke coverage with PDF, text, CSV, code, unsupported binary, and mixed attachment messages.

Edge cases to cover:

- Provider supports images but not files.
- Provider supports a subset of file MIME types.
- Mixed image and file attachments.
- File name sanitization without leaking local paths.
- Raw bytes/base64 never appearing in logs, Telegram output, or text fallbacks.
- Extraction fallback when native file support is disabled or rejected by provider.

Required testing:

- Unit tests for native file input preparation and fallback conversion.
- Orchestrator tests proving `allowNativeFiles` follows model capabilities.
- Transport tests proving unsupported file blocks do not become image blocks.
- Attachment smoke tests through `pnpm smoke:suite` once a provider-native file path exists.

Verification:

- `corepack pnpm check`
- `corepack pnpm vitest run test/codex/provider.test.ts test/codex/transport.test.ts test/telegram/attachments.test.ts test/runs/helpers.test.ts test/runs/run-orchestrator.integration.test.ts`
- `corepack pnpm test`
- `corepack pnpm test:coverage`
- `corepack pnpm build`
