# Testing

## Test Strategy

The test suite is organized around the system boundaries that matter operationally:

- pure helpers and state derivation
- SQLite-backed stores
- auth parsing and refresh behavior
- provider model selection and usage normalization
- transport fallback behavior
- Telegram command and outbox behavior
- full run orchestration across queue, storage, transport, and rendering
- deny-by-default tool registry behavior

The current stack uses Vitest with V8 coverage.

## Commands

Install dependencies from the lockfile:

```bash
pnpm install --frozen-lockfile
```

Fresh installs with pnpm 10 may block native dependency build scripts. If `better-sqlite3` cannot load and tests fail with "Could not locate the bindings file", approve or rebuild the native package before rerunning tests:

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

Run the TypeScript check:

```bash
pnpm check
```

Run the suite:

```bash
pnpm test
```

Run the suite with coverage:

```bash
pnpm test:coverage
```

## CI Verification

GitHub Actions workflow: `.github/workflows/ci.yml`.

The CI gate runs on pushes to `main` and pull requests. It:

- enables Corepack and uses the pinned `pnpm@10.33.0`
- installs dependencies with `pnpm install --frozen-lockfile`
- rebuilds the native `better-sqlite3` binding
- runs `pnpm check`, `pnpm test`, `pnpm test:coverage`, and `pnpm build`
- verifies `dist/index.js` exists, `package.json` remains private, and `bin.mottbot` points to `./dist/index.js`
- runs the built CLI health command against a temporary SQLite database
- fails if the worktree is dirty after verification

The CI workflow does not require live Telegram or Codex secrets. Live integration remains a guarded operator-run workflow through `pnpm smoke:preflight`.

For private-chat live validation without manually typing in Telegram every time, use the optional MTProto harness:

```bash
pnpm smoke:telegram-user
```

It is skipped unless `MOTTBOT_USER_SMOKE_ENABLED=true` is set. It requires `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, stores an ignored local user session, and is intentionally excluded from CI and coverage.

## Verified Results

Verified locally on April 19, 2026:

- `pnpm check`: passes
- `pnpm test`: 46 test files, 151 tests passing
- `pnpm test:coverage`: passes
- `pnpm build`: passes
- built CLI health check: passes
- `pnpm smoke:preflight`: passes in skipped mode when `MOTTBOT_LIVE_SMOKE_ENABLED` is unset

The mocked OAuth login test intentionally prints a normalized authorization URL to stdout:

```text
https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access+model.request+api.responses.write
```

Last recorded coverage run on April 19, 2026:

| Metric | Result |
| --- | ---: |
| Statements | 84.73% |
| Branches | 73.81% |
| Functions | 90.93% |
| Lines | 84.78% |

Coverage thresholds are enforced in `vitest.config.ts`:

- statements: 84%
- branches: 70%
- functions: 88%
- lines: 84%

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
- `test/app/service.test.ts`

### Database migrations and retention

Covers:

- versioned migration ledger creation
- empty database bootstrap
- unversioned database bootstrap without data loss
- migration checksum mismatch failure
- queue recovery indexes and foreign keys
- retention pruning safety

Primary tests:

- `test/db/migrate.test.ts`
- `test/db/retention.test.ts`

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
- unknown model refs and unsafe command arguments are rejected before mutating session settings
- invalid non-Codex provider refs are rejected at the provider boundary
- expired profiles without refresh tokens fail before model execution
- failed refreshes preserve existing credentials
- failed CLI auth write-back preserves refreshed encrypted database credentials
- usage timeouts and sparse usage payloads normalize into safe status behavior
- the tool registry exposes only enabled read-only declarations
- unknown tools, disabled tools, side-effecting enabled tools, and invalid tool inputs are rejected
- Codex tool-call events are normalized before run orchestration sees them
- read-only tool calls execute with timeout, output-size, and call-count limits
- tool results are persisted as `tool` transcript rows and returned to the provider in the active turn
- non-admin group commands and disallowed-chat commands are rejected before route creation
- retention pruning removes old terminal operational rows without deleting active runs or reply ACL rows
- Telegram attachment metadata is normalized and rendered into prompt text without exposing path-like prefixes
- supported image attachments are downloaded, converted into native model image inputs, and cleaned from the local cache
- text, Markdown, code, CSV, TSV, and PDF attachments are extracted into bounded active-run prompt context without persisting raw extracted text
- file metadata can be listed and forgotten without clearing unrelated transcript text
- inbound text and attachment safety-limit violations are rejected before command or model routing
- durable queue rows prevent duplicate active claims and allow queued runs to resume after restart
- interrupted runs are recovered as failed on restart
- processed Telegram updates are deduplicated durably
- webhook mode configures the local server and Telegram webhook registration correctly
- polling mode logs and retries Telegram 409 conflicts from another active poller
- interrupted outbox rows are marked failed and partial text is recoverable after restart

## Current Gaps

The suite is broad, but it does not yet prove everything that a hardened production bot would need.

Not fully covered today:

- live Telegram polling against a real bot token
- live Telegram webhook delivery against a public endpoint
- real ChatGPT/Codex OAuth against an operator account
- live subscription-backed model calls
- full end-to-end crash recovery across process restart and fresh inbound traffic
- native provider file-block support for non-image attachment types
- side-effecting model-executed tools

## Why The Coverage Is Good Enough For The Current Repo

The highest-risk local behaviors are covered:

- route and session identity
- auth parsing and token lifecycle
- transport fallback behavior
- transcript persistence
- user-facing command and outbox behavior
- end-to-end run orchestration with integration tests

The remaining risk is mostly on external integrations and hardening features that are intentionally deferred.

## Phase 0 Verification Notes

The April 19, 2026 baseline was produced from a clean working tree after dependency installation and native SQLite binding approval. The commands used were:

```bash
corepack pnpm check
corepack pnpm test
```

Use plain `pnpm` when it is already installed on the host. `corepack pnpm` is equivalent for hosts where Corepack manages pnpm.
