# Operations

## Operating Posture

This repo is designed for one long-lived local or single-host process.

Recommended posture:

- one process
- one SQLite file
- polling or webhook mode
- private or admin-controlled chats first

Do not treat the current implementation as a multi-instance bot service.

## Local Setup

1. Install dependencies:

```bash
pnpm install --frozen-lockfile
```

If pnpm 10 blocks native dependency build scripts on a fresh checkout, approve the workspace builds or rebuild `better-sqlite3` before running tests or starting the bot:

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

2. Create configuration:

- copy `.env.example` to `.env`
- set `TELEGRAM_BOT_TOKEN`
- set `MOTTBOT_MASTER_KEY`

3. Initialize the database:

```bash
pnpm db:migrate
```

4. Bootstrap auth:

```bash
pnpm auth:import-cli
```

or:

```bash
pnpm auth:login
```

5. Start the bot:

```bash
pnpm dev
```

Webhook deployments additionally need:

- `MOTTBOT_TELEGRAM_POLLING=false`
- `MOTTBOT_TELEGRAM_WEBHOOK_URL`
- optional webhook path, host, port, and secret token overrides

## Test Environment Checklist

Use a private operator-only test environment before live validation.

Required items:

- a Telegram bot token from BotFather stored in `TELEGRAM_BOT_TOKEN`
- a strong local `MOTTBOT_MASTER_KEY`
- the operator's Telegram user ID in `MOTTBOT_ADMIN_USER_IDS`
- optional test chat IDs in `MOTTBOT_ALLOWED_CHAT_IDS`
- a development SQLite path such as `./data/mottbot.sqlite`
- a separate live-integration SQLite path such as `./data/mottbot.integration.sqlite`
- a Codex auth source, either `$CODEX_HOME/auth.json` for CLI import or local OAuth through `pnpm auth:login`
- webhook public URL and secret token values when testing webhook mode

Bot setup and teardown:

- create a test bot with BotFather and keep the token out of git
- add the bot only to private test chats or controlled test groups
- revoke or rotate the token in BotFather after test environments are retired

Secret handling:

- never commit `.env`, `mottbot.config.json`, SQLite files, WAL files, Codex auth files, Telegram tokens, OAuth access tokens, OAuth refresh tokens, or dashboard auth tokens
- keep development and live-integration SQLite files separate so destructive recovery tests cannot affect normal local state
- prefer temporary test chats for webhook and restart-recovery validation

## Dashboard Operations

The runtime can expose a local dashboard for health checks and easier file-backed configuration.

Default endpoint:

- `http://127.0.0.1:8787/dashboard`

Environment overrides:

- `MOTTBOT_DASHBOARD_ENABLED`
- `MOTTBOT_DASHBOARD_HOST`
- `MOTTBOT_DASHBOARD_PORT`
- `MOTTBOT_DASHBOARD_PATH`
- `MOTTBOT_DASHBOARD_API_PATH`
- `MOTTBOT_DASHBOARD_AUTH_TOKEN`

Operational notes:

- dashboard writes updates to the configured config path (default: `mottbot.config.json`, overridden by `MOTTBOT_CONFIG_PATH`)
- environment variables still override file values
- restart the process after saving config updates

## CLI Entry Points

The binary exposes these commands:

```text
mottbot start
mottbot auth login
mottbot auth import-cli
mottbot db migrate
mottbot db prune --older-than-days 30 --dry-run
```

Equivalent `pnpm` scripts:

- `pnpm dev`
- `pnpm build`
- `pnpm start`
- `pnpm check`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`
- `pnpm db:prune`
- `pnpm health`
- `pnpm service install --start`
- `pnpm service status`
- `pnpm run restart`
- `pnpm smoke:preflight`

## Persistent macOS Service

Use `SETUP.md` for the full host-local service runbook.

The supported persistent local setup is a macOS user LaunchAgent:

- label: `ai.mottbot.bot`
- plist: `~/Library/LaunchAgents/ai.mottbot.bot.plist`
- logs: `~/Library/Logs/mottbot/`
- command: absolute Node binary plus `node_modules/tsx/dist/cli.mjs src/index.ts start`

Common commands:

```bash
corepack pnpm service install --start
corepack pnpm service status
corepack pnpm run restart
corepack pnpm service stop
```

Runtime secrets remain in `.env`, not in the LaunchAgent plist.

Polling conflict behavior:

- Telegram permits only one active `getUpdates` consumer per bot token.
- If a second consumer exists, Mottbot logs the conflict and retries every 30 seconds instead of exiting.
- The bot still cannot receive updates until the other poller stops or the token is rotated.

## Migration Operations

`mottbot db migrate` applies ordered SQL migrations and records them in `schema_migrations`.

Current behavior:

- `0001_initial.sql` is the baseline schema migration
- migrations are idempotent and safe to run repeatedly
- an existing migration row with a different checksum stops startup instead of continuing with an unknown schema state
- unversioned databases that already have the current tables are bootstrapped into the migration ledger without dropping rows

Backup before migration:

1. Stop the bot process.
2. Copy the configured SQLite file from `MOTTBOT_SQLITE_PATH` or `storage.sqlitePath`.
3. Also copy the WAL sidecar files when present:

```text
mottbot.sqlite
mottbot.sqlite-wal
mottbot.sqlite-shm
```

4. Store the backup outside the repo and outside ignored runtime directories that may be cleaned.
5. Run `pnpm db:migrate`.
6. Start the bot and run `pnpm health`.

Rollback expectation:

- stop the bot
- restore the database file and matching `-wal` and `-shm` files from the same backup point
- start the bot again

Do not hand-edit rows in `schema_migrations`. If a checksum mismatch appears, treat it as a migration-file integrity problem and inspect the local diff before retrying.

## Data Retention Operations

`mottbot db prune` removes old operational rows without touching auth profiles or session routes.

Default behavior is a dry run:

```bash
pnpm db:prune
```

To delete rows older than a chosen age:

```bash
tsx src/index.ts db prune --older-than-days 30 --yes
```

Retention safety rules:

- `queued`, `starting`, and `streaming` runs are never pruned
- `active` outbox rows are never pruned
- `queued` and `claimed` queue rows are retained
- completed and failed queue rows can be pruned by age
- terminal runs are pruned only after old child outbox, bot-message, and transcript rows are safe to remove
- processed Telegram update IDs are pruned by `processed_at`, which means very old duplicate updates can be accepted again
- session routes and auth profiles are not pruned by this command

Back up the SQLite file before running destructive pruning on a production host.

## Attachment Operations

Attachment settings:

- `attachments.cacheDir` or `MOTTBOT_ATTACHMENT_CACHE_DIR`
- `attachments.maxFileBytes` or `MOTTBOT_ATTACHMENT_MAX_FILE_BYTES`
- `attachments.maxTotalBytes` or `MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES`
- `attachments.maxPerMessage` or `MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE`

Runtime behavior:

- supported images are downloaded from Telegram only when the selected model accepts image input
- downloaded bytes are converted into native image blocks for the model request
- non-image attachments are preserved as text metadata
- cache files are deleted after model request construction or failure cleanup
- current Pi AI payload support used by the repo exposes text and image blocks only, so PDFs, office files, audio, video, stickers, and animations are not passed as native model inputs

Keep the attachment cache under `data/` or another ignored local path. Do not point it at a committed directory.

## Operator Safety Limits

Ingress safety settings:

- `behavior.maxInboundTextChars` or `MOTTBOT_MAX_INBOUND_TEXT_CHARS`
- `attachments.maxPerMessage` or `MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE`
- `attachments.maxFileBytes` or `MOTTBOT_ATTACHMENT_MAX_FILE_BYTES`
- `attachments.maxTotalBytes` or `MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES`

Rejected messages receive a Telegram reply explaining the limit. They are recorded as processed updates, but they do not create runs, transcript rows, or queued work.

## Live Smoke Operations

Use `docs/live-smoke-tests.md` for external integration validation.

Local preflight:

```bash
pnpm smoke:preflight
```

By default the command prints `status: skipped`. It validates a configured live environment only when `MOTTBOT_LIVE_SMOKE_ENABLED=true` is set.

Preflight checks:

- configuration and required secrets can be loaded
- Telegram `getMe` accepts the configured bot token
- SQLite migrations apply cleanly
- the default auth profile is present
- admin IDs are configured
- webhook mode has a public URL when polling is disabled
- health counters and migration versions can be read without printing tokens

## Auth Operations

### Importing Codex CLI auth

Use this when the host already has a ChatGPT-backed Codex CLI login.

Behavior:

- reads `$CODEX_HOME/auth.json` or `~/.codex/auth.json`
- imports only `chatgpt` auth mode
- writes the result into the configured default profile

### Local OAuth login

Use this when the bot should own its own local OAuth profile.

Behavior:

- opens a browser to the authorize URL
- prints the same URL for manual use
- accepts prompt and manual code input through stdin
- stores the resulting profile in SQLite

Operational advice:

- run OAuth login on the same host that will run the bot
- do not attempt to drive OAuth inside Telegram

## Telegram Operations

Current runtime:

- polling or webhook mode
- one message handler
- one placeholder message per run
- in-place edits during streaming

Admin controls are exposed through Telegram commands:

- `/status`
- `/health`
- `/model`
- `/profile`
- `/fast`
- `/reset`
- `/stop`
- `/bind`
- `/unbind`
- `/auth status`
- `/auth import-cli`
- `/auth login`

Command authorization:

- configured admin users can run commands in any chat
- non-admin users can run commands only in private chats
- if `MOTTBOT_ALLOWED_CHAT_IDS` is set, non-admin private commands must come from a listed chat
- non-admin group and supergroup commands are rejected before creating or mutating a session route

Command validation:

- `/model` accepts only known built-in Codex model refs
- `/profile <profile_id>` requires an existing profile ID with a safe command-line shape
- `/bind [name]` accepts at most 64 visible characters

## Failure Handling

Current behavior:

- auth refresh failures bubble up as run failures
- stream errors are shown in chat as `Run failed: ...`
- active run cancellation marks the run `cancelled`
- WebSocket transport failures can fall back to SSE automatically
- outbox finalize or fail paths send a fresh message if editing the placeholder fails
- queued runs accepted before a restart are resumed when session and transcript context still exist
- unrecoverable queued runs are marked failed and the chat is notified when possible
- interrupted `starting` and `streaming` runs are still marked failed on restart

Current limitation:

- durable queue recovery is single-process only and is not safe for active multi-replica execution

## Logging

The app uses structured logging through pino.

Useful log events today:

- bot startup
- rejected Telegram updates
- token refresh events
- queued run, run start, run completion, and run failure with safe run/session/chat fields
- transport fallback warnings
- run execution failures
- Telegram edit failures
- attachment download or cleanup failures

Health output includes:

- queued runs
- active runs
- interrupted runs
- stale active outbox messages
- degraded transport sessions
- processed Telegram updates

## Deployment Guidance

Good fit:

- a local machine
- a single VPS
- a small private operator bot

Poor fit without more work:

- multiple bot replicas
- a public shared bot
- any deployment that requires strong crash recovery guarantees

## Hardening Backlog

The most important operational gaps are:

- richer transcript summarization
- migration discipline for future schema changes
