# Mottbot

Telegram-first Codex subscription bot scaffold that mirrors OpenClaw's `openai-codex` provider shape.

## What this repo implements

- Telegram polling bot via `grammY`
- Optional webhook mode with local HTTP listener and Telegram webhook registration
- SQLite-backed session, run, outbox, and auth profile storage
- OpenClaw-style `openai-codex` provider boundary
- ChatGPT/Codex OAuth bootstrap command
- Codex CLI auth reuse from `$CODEX_HOME/auth.json` or `~/.codex/auth.json`
- Per-session run serialization
- Durable Telegram update dedupe and bot-reply tracking
- Restart recovery for interrupted runs
- Attachment-aware prompt construction and transcript compaction
- Streaming-ready run orchestration and Telegram outbox editing
- Local dashboard for runtime health and file-backed configuration updates
- CLI and Telegram health reporting

## Quick start

1. Install dependencies:

```bash
pnpm install
```

2. Copy `.env.example` to `.env` and fill in:

- `TELEGRAM_BOT_TOKEN`
- `MOTTBOT_MASTER_KEY`

3. Import or create auth:

```bash
pnpm auth:import-cli
# or
pnpm auth:login
```

4. Start the bot:

```bash
pnpm dev
```

For persistent macOS service setup and CLI restarts, see [SETUP.md](./SETUP.md).

5. Open the dashboard:

- `http://127.0.0.1:8787/dashboard` (defaults)
- use `MOTTBOT_DASHBOARD_*` env vars to rebind/disable/auth-protect it
- dashboard saves to the configured config path (default: `mottbot.config.json`); restart required after changes

## Commands

- `pnpm dev`
- `pnpm build`
- `pnpm check`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`
- `pnpm health`
- `pnpm service status`
- `pnpm restart`

## Docs

- [Persistent setup](./SETUP.md)
- [Docs index](./docs/README.md)
- [Architecture](./docs/architecture.md)
- [Telegram runtime](./docs/telegram-runtime.md)
- [Codex subscription provider](./docs/codex-subscription-provider.md)
- [Data model](./docs/data-model.md)
- [Testing](./docs/testing.md)
- [Operations](./docs/operations.md)
- [Completion and test plan](./docs/completion-test-plan.md)
- [Single-file design brief](./docs/telegram-codex-design.md)
