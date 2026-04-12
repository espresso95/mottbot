# Testing

## Test Strategy

The test suite is organized around the system boundaries that matter operationally:

- pure helpers and state derivation
- SQLite-backed stores
- auth parsing and refresh behavior
- transport fallback behavior
- Telegram command and outbox behavior
- full run orchestration across queue, storage, transport, and rendering

The current stack uses Vitest with V8 coverage.

## Commands

Run the suite:

```bash
pnpm test
```

Run the suite with coverage:

```bash
pnpm test:coverage
```

## Verified Results

Verified locally on April 12, 2026:

- `pnpm test`: 31 test files, 69 tests passing
- `pnpm test:coverage`: 31 test files, 69 tests passing

Coverage summary:

| Metric | Result |
| --- | ---: |
| Statements | 86.33% |
| Branches | 71.06% |
| Functions | 91.04% |
| Lines | 86.35% |

## Coverage Map

### App bootstrap and config

Covers:

- config file and env precedence
- required secret enforcement
- bootstrap wiring
- shutdown handler behavior

Primary tests:

- `test/app/config.test.ts`
- `test/app/bootstrap.test.ts`
- `test/app/shutdown.test.ts`

### Session and transcript model

Covers:

- session key generation
- route persistence
- profile/model/fast mode updates
- bind and unbind behavior
- transcript persistence and clearing
- queue serialization and cancellation

Primary tests:

- `test/sessions/session-key.test.ts`
- `test/sessions/queue.test.ts`
- `test/sessions/session-store.integration.test.ts`
- `test/sessions/transcript-store.integration.test.ts`

### Run execution

Covers:

- prompt construction
- run persistence
- success path and failure path
- assistant transcript write-back
- usage recording
- cancellation behavior through the queue

Primary tests:

- `test/runs/prompt-builder.test.ts`
- `test/runs/run-store.integration.test.ts`
- `test/runs/run-orchestrator.integration.test.ts`

### Telegram runtime

Covers:

- update normalization
- durable update dedupe
- ACL decisions
- route resolution
- command handling
- outbox start, update, finalize, and fail behavior
- outbox recovery behavior
- polling and webhook bot lifecycle behavior

Primary tests:

- `test/telegram/update-normalizer.test.ts`
- `test/telegram/acl.test.ts`
- `test/telegram/route-resolver.test.ts`
- `test/telegram/commands.integration.test.ts`
- `test/telegram/outbox.integration.test.ts`
- `test/telegram/bot.test.ts`

### Codex provider boundary

Covers:

- auth store encryption and retrieval
- Codex CLI auth parsing and import
- OAuth login behavior around prompts and scope normalization
- token resolver refresh flow and lock behavior
- transport fallback to SSE
- degraded transport cache behavior
- no fallback after partial stream progress
- usage endpoint normalization

Primary tests:

- `test/codex/auth-store.integration.test.ts`
- `test/codex/cli-auth-import.test.ts`
- `test/codex/oauth-login.test.ts`
- `test/codex/token-resolver.test.ts`
- `test/codex/transport.test.ts`
- `test/codex/usage.test.ts`

## Important Behaviors Proven By Tests

The current suite catches several subtle behaviors that matter in production:

- cancelling a queued or running session does not leak an unhandled rejection from the queue tail
- unbinding a previously bound DM session restores the correct route mode instead of incorrectly downgrading it to a group route
- transport fallback does not rerun a request after partial stream progress
- degraded SSE backoff remains active after a successful fallback
- unknown profiles are rejected instead of poisoning future runs
- interrupted runs are recovered as failed on restart
- processed Telegram updates are deduplicated durably
- webhook mode configures the local server and Telegram webhook registration correctly
- interrupted outbox rows are marked failed and partial text is recoverable after restart

## Current Gaps

The suite is broad, but it does not yet prove everything that a hardened production bot would need.

Not fully covered today:

- live Telegram polling against a real bot token
- live Telegram webhook delivery against a public endpoint
- real ChatGPT/Codex OAuth against an operator account
- live subscription-backed model calls
- full end-to-end crash recovery across process restart and fresh inbound traffic
- native attachment ingestion into model prompts

## Why The Coverage Is Good Enough For The Current Repo

The highest-risk local behaviors are covered:

- route and session identity
- auth parsing and token lifecycle
- transport fallback behavior
- transcript persistence
- user-facing command and outbox behavior
- end-to-end run orchestration with integration tests

The remaining risk is mostly on external integrations and hardening features that are intentionally deferred.
