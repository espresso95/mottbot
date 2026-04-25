# Mottbot

Mottbot is a host-local Telegram control plane for subscription-backed Codex runs. It is intentionally narrow: one process owns Telegram ingress, SQLite state, Codex auth and transport, tool approvals, the local dashboard, and optional Project Mode scheduling.

This is not a generic multi-channel bot and it is not the standard OpenAI API-key path. The Codex-specific behavior stays isolated under `src/codex/*` and `src/codex-cli/*`.

## What It Does

- Handles Telegram polling or webhook updates through `grammY`.
- Persists sessions, transcripts, runs, queue state, outbox messages, auth profiles, roles, chat policy, memory, tool approvals, and Project Mode task state in SQLite.
- Reuses Codex CLI auth or creates a local ChatGPT/Codex OAuth profile.
- Streams Codex-backed model output into Telegram with per-session serialization and restart recovery.
- Supports named agents, route bindings, usage budgets, attachment handling, memory, admin diagnostics, and a local dashboard.
- Exposes deny-by-default model tools. Side-effecting tools are disabled by default and require explicit admin approval for real execution.
- Runs optional Project Mode tasks in isolated Git worktrees and requires explicit approval before publishing branches or opening pull requests.

## Operating Assumptions

- Use `pnpm` for installs, scripts, and lockfile changes.
- Keep `.env` files, local config with secrets, SQLite files, `data/`, `dist/`, and `coverage/` out of git.
- Run it as one host-local process against one SQLite database. Distributed multi-instance coordination is out of scope beyond the host-local lease guard.
- Use a dedicated test bot, test chats, and separate SQLite path for live smoke testing.
- Treat side-effecting tools and Project Mode publish actions as operator-controlled workflows, not autonomous deployment paths.

## Known Gaps

- Native provider file blocks for non-image attachments remain disabled until the active Codex provider boundary supports them; supported documents are converted into bounded prompt text.
- Webhook delivery and live Codex fault-injection checks still require operator-provided live environments.
- Usage budgets are local run-count controls, not billing-grade token or currency limits.
- Channel bindings beyond Telegram and distributed replicas are not implemented.

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Create `mottbot.config.json` from the JSON template and set secrets:

```bash
cp mottbot.config.example.json mottbot.config.json
```

Then set at minimum:

- `telegram.botToken`
- `security.masterKey`

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
- use `dashboard.*` keys in `mottbot.config.json` to rebind/disable/auth-protect it
- dashboard saves to the configured config path (default: `mottbot.config.json`); restart required after changes

## Commands

- `pnpm dev`
- `pnpm build`
- `pnpm check`
- `pnpm lint`
- `pnpm format:check`
- `pnpm tsdoc:audit -- --strict`
- `pnpm docs:check`
- `pnpm knip`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm verify`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`
- `pnpm health`
- `pnpm service status`
- `pnpm run restart`
- `pnpm smoke:dashboard`
- `pnpm smoke:local-tools`
- `pnpm smoke:suite`

## Docs

- [Persistent setup](./SETUP.md)
- [Docs index](./docs/README.md)
- [Architecture](./docs/architecture.md)
- [Telegram runtime](./docs/telegram-runtime.md)
- [Codex subscription provider](./docs/codex-subscription-provider.md)
- [Data model](./docs/data-model.md)
- [Testing](./docs/testing.md)
- [Code quality](./docs/code-quality.md)
- [Operations](./docs/operations.md)
- [Live smoke tests](./docs/live-smoke-tests.md)
- [Tool use](./docs/tool-use-design.md)
- [Release notes](./docs/release-notes.md)
