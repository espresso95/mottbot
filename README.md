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

## Commands

- `pnpm dev`
- `pnpm build`
- `pnpm check`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`
- `pnpm health`

## Docs

- [Docs index](/Users/nimoraki/mottbot/docs/README.md)
- [Architecture](/Users/nimoraki/mottbot/docs/architecture.md)
- [Telegram runtime](/Users/nimoraki/mottbot/docs/telegram-runtime.md)
- [Codex subscription provider](/Users/nimoraki/mottbot/docs/codex-subscription-provider.md)
- [Data model](/Users/nimoraki/mottbot/docs/data-model.md)
- [Testing](/Users/nimoraki/mottbot/docs/testing.md)
- [Operations](/Users/nimoraki/mottbot/docs/operations.md)
- [Single-file design brief](/Users/nimoraki/mottbot/docs/telegram-codex-design.md)
