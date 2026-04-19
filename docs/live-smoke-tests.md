# Live Smoke Tests

## Purpose

This runbook covers validation that cannot be proven by the local Vitest suite: real Telegram delivery, real Codex subscription-backed model calls, webhook ingress, and operator-visible recovery behavior.

Run these checks only with a dedicated test bot, test chats, and a separate SQLite file.

## Safety Guard

The repository includes a guarded preflight:

```bash
pnpm smoke:preflight
```

The command exits with `status: skipped` unless this variable is set:

```bash
export MOTTBOT_LIVE_SMOKE_ENABLED=true
```

When enabled, preflight loads config, runs migrations, reads health counters, verifies the default auth profile is present, and prints a token-free JSON summary. It does not send Telegram messages or make Codex model calls.

## Required Environment

Use a separate `.env` or shell session with:

```bash
export TELEGRAM_BOT_TOKEN=...
export MOTTBOT_MASTER_KEY=...
export MOTTBOT_ADMIN_USER_IDS=...
export MOTTBOT_SQLITE_PATH=./data/mottbot.integration.sqlite
export MOTTBOT_ATTACHMENT_CACHE_DIR=./data/attachments.integration
export MOTTBOT_LIVE_SMOKE_ENABLED=true
```

Optional filters:

```bash
export MOTTBOT_ALLOWED_CHAT_IDS=...
export MOTTBOT_DEFAULT_PROFILE=openai-codex:default
export MOTTBOT_DEFAULT_MODEL=openai-codex/gpt-5.4
```

Do not reuse the normal development SQLite database for destructive restart or fault-injection checks.

## Preflight

1. Run migrations:

```bash
pnpm db:migrate
```

2. Import or create auth:

```bash
pnpm auth:import-cli
```

or:

```bash
pnpm auth:login
```

3. Run the guarded preflight:

```bash
pnpm smoke:preflight
```

Expected result:

- `status` is `ready`
- `issues` is empty
- `migrations` includes version `1`
- `authProfiles` is at least `1`

## Polling Matrix

Start the bot:

```bash
pnpm dev
```

Run these manual checks from the configured test chats.

| Check | Input | Expected result |
| --- | --- | --- |
| Private text | `hello` | Placeholder appears, streams, then finalizes. |
| Private command | `/health` | Health text returns without starting a model run. |
| Unknown model | `/model bad/model` | Clear rejection and current route unchanged. |
| Group mention | `@<botname> hello` | Bot responds when mention gating is enabled. |
| Group unmentioned text | `hello` | Bot ignores the message when mention gating is enabled. |
| Reply gating | Reply to a bot-authored message | Bot accepts the reply. |
| Bound route | `/bind smoke-test` then unmentioned text | Bot accepts the bound route. |
| Stop | Send a long prompt, then `/stop` | Active run is cancelled and user-visible state is clear. |
| Image attachment | Send a supported image | Image is included as native model input for image-capable models. |
| Non-image attachment | Send a PDF or document | Attachment is summarized as metadata, not sent as a native file block. |

After the run:

```bash
pnpm health
```

Confirm no unexpected interrupted runs remain.

## Webhook Matrix

Use a public HTTPS endpoint that reaches the local or test host, then configure:

```bash
export MOTTBOT_TELEGRAM_POLLING=false
export MOTTBOT_TELEGRAM_WEBHOOK_URL=https://example.test
export MOTTBOT_TELEGRAM_WEBHOOK_SECRET_TOKEN=...
```

Start the bot and verify:

- Telegram webhook registration succeeds.
- Valid Telegram updates reach the bot.
- `GET` requests to the webhook path are rejected.
- wrong paths are rejected.
- requests without the configured secret token are rejected.
- teardown clears or replaces the webhook before returning to polling mode.

## Codex Matrix

Run these checks after Telegram delivery is working:

- one short text prompt completes successfully
- one prompt produces enough output to exercise placeholder edits
- `/status` returns usage information or a clear degraded usage message
- image-capable model receives a native image block for a small JPEG or PNG
- text-only model treats the same image as attachment metadata

Current provider boundary:

- text and image inputs are supported
- non-image files remain metadata until the provider exposes a supported native file block

## Restart And Fault Checks

Use the integration SQLite database only.

Queued restart:

1. Send a prompt.
2. Stop the process before model execution starts if possible.
3. Restart with `pnpm dev`.
4. Confirm recoverable queued work resumes once.

Interrupted stream:

1. Start a long response.
2. Stop the process during streaming.
3. Restart.
4. Confirm the interrupted run is marked failed and `/health` reflects the final state.

Telegram edit fallback:

- induce or simulate edit failure in a controlled test and confirm the outbox sends a replacement message instead of losing the response.

Auth failure:

- temporarily point to a missing or invalid auth profile and confirm the run fails with a clear Telegram message without logging credentials.

## Cleanup

After live testing:

- stop the bot
- remove the integration SQLite file and its `-wal` and `-shm` sidecars
- remove the integration attachment cache
- revoke or rotate the BotFather token if the bot will not be reused
- clear public webhook tunnels or HTTPS routes
