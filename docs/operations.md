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
pnpm install
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

- dashboard writes updates to `mottbot.config.json`
- environment variables still override file values
- restart the process after saving config updates

## CLI Entry Points

The binary exposes these commands:

```text
mottbot start
mottbot auth login
mottbot auth import-cli
mottbot db migrate
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
- `pnpm health`

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

## Failure Handling

Current behavior:

- auth refresh failures bubble up as run failures
- stream errors are shown in chat as `Run failed: ...`
- active run cancellation marks the run `cancelled`
- WebSocket transport failures can fall back to SSE automatically
- outbox finalize or fail paths send a fresh message if editing the placeholder fails

Current limitation:

- restart recovery is implemented for interrupted runs, but it does not currently re-notify Telegram chats after process restart

## Logging

The app uses structured logging through pino.

Useful log events today:

- bot startup
- rejected Telegram updates
- token refresh events
- transport fallback warnings
- run execution failures
- Telegram edit failures

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

- native attachment handling
- richer transcript summarization
- migration discipline for future schema changes
