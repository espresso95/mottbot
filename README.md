# Mottbot

Telegram-first Codex subscription bot scaffold that mirrors OpenClaw's `openai-codex` provider shape.

## What this repo implements

- Telegram polling bot via `grammY`
- SQLite-backed session, run, outbox, and auth profile storage
- OpenClaw-style `openai-codex` provider boundary
- ChatGPT/Codex OAuth bootstrap command
- Codex CLI auth reuse from `$CODEX_HOME/auth.json` or `~/.codex/auth.json`
- Per-session run serialization
- Streaming-ready run orchestration and Telegram outbox editing

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

## Commands

- `pnpm dev`
- `pnpm build`
- `pnpm check`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`

## Docs

- [Design doc](/Users/nimoraki/mottbot/docs/telegram-codex-design.md)
