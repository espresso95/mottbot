# Live Smoke Tests

## Purpose

This runbook covers validation that cannot be proven by the local Vitest suite: real Telegram delivery, real Codex subscription-backed model calls, webhook ingress, and operator-visible recovery behavior.

Run these checks only with a dedicated test bot, test chats, and a separate SQLite file.

Smoke variables are intentionally separate from normal runtime configuration. They are **scenario inputs** for `pnpm smoke:*` helpers, so they do not change bot behavior unless you run those commands explicitly.

## Smoke Variable Policy

You do not need a permanent second `.env` file with every smoke variable set.

- Export only the variables needed for the command you are about to run.
- Unset sensitive one-time values (for example `TELEGRAM_LOGIN_CODE`) after the run.

Minimal command requirements:

| Command | Required variables | Optional variables |
| --- | --- | --- |
| `pnpm smoke:preflight` | none | `MOTTBOT_LIVE_TEST_CHAT_ID`, `MOTTBOT_LIVE_TEST_MESSAGE` |
| `pnpm smoke:telegram-user` | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `MOTTBOT_LIVE_BOT_USERNAME` | `TELEGRAM_PHONE_NUMBER`, `TELEGRAM_LOGIN_CODE`, `TELEGRAM_2FA_PASSWORD`, `TELEGRAM_USER_SESSION`, `MOTTBOT_USER_SMOKE_*` tuning values |
| `pnpm smoke:suite` | none (plus Telegram user credentials only if user-smoke scenarios are included) | `MOTTBOT_LIVE_VALIDATION_*` scenario filters/messages/fixtures |
| `pnpm smoke:github-write` | `MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY` | `MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN`, `MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM`, title/body/labels/PR number overrides |
| `pnpm smoke:dashboard` | none | `MOTTBOT_DASHBOARD_SMOKE_PORT` |

## Safety Guard

The repository includes a guarded preflight:

```bash
pnpm smoke:preflight
```

Preflight loads config, validates the bot token with Telegram `getMe`, runs migrations, reads health counters, verifies the default auth profile is present, and prints a token-free JSON summary. It does not send Telegram messages or make Codex model calls.

Optional outbound Telegram delivery check:

```bash
export MOTTBOT_LIVE_TEST_CHAT_ID=<operator-or-test-chat-id>
export MOTTBOT_LIVE_TEST_MESSAGE="Mottbot live smoke outbound check."
pnpm smoke:preflight
```

When `MOTTBOT_LIVE_TEST_CHAT_ID` is set, preflight sends one silent Telegram message and reports the resulting `messageId`. This proves Bot API outbound delivery, but it does not prove inbound user updates.

For private chats, the target user must have already opened or started the bot. Telegram rejects bot-initiated conversations with users who have not done that.

## Live Validation Suite

For repeatable live validation, run the suite wrapper:

```bash
pnpm smoke:suite
```

Start with a dry run to see exactly which checks will execute without sending Telegram messages:

```bash
MOTTBOT_LIVE_VALIDATION_DRY_RUN=true \
pnpm smoke:suite
```

The suite always includes `smoke:preflight`. When `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `MOTTBOT_LIVE_BOT_USERNAME` are present, it also composes the MTProto user-account harness into:

- private model conversation
- `/health`
- `/usage`
- reply-to-latest-bot-message conversation
- optional group mention conversation
- optional attachment fixture uploads

Useful controls:

```bash
export MOTTBOT_LIVE_VALIDATION_SCENARIOS=preflight,private,health,usage,reply,group_mention,files
export MOTTBOT_LIVE_VALIDATION_REQUIRE_USER_SMOKE=true
export MOTTBOT_LIVE_VALIDATION_GROUP_TARGET=<group-or-bot-entity>
export MOTTBOT_LIVE_VALIDATION_FILE_PATHS=/absolute/path/a.txt,/absolute/path/b.png
export MOTTBOT_LIVE_VALIDATION_FORCE_DOCUMENT=false
```

Scenario filtering is optional. When omitted, the suite runs every scenario it can run with the available environment and reports skipped optional group/file checks in token-free JSON.

## Required Environment

Use a separate `.env` or shell session with:

```bash
export TELEGRAM_BOT_TOKEN=...
export MOTTBOT_MASTER_KEY=...
export MOTTBOT_ADMIN_USER_IDS=...
export MOTTBOT_SQLITE_PATH=./data/mottbot.integration.sqlite
export MOTTBOT_ATTACHMENT_CACHE_DIR=./data/attachments.integration
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
- `telegramBot.username` matches the test bot
- `migrations` includes version `1`
- `authProfiles` is at least `1`
- `outboundCheck.status` is `skipped` unless `MOTTBOT_LIVE_TEST_CHAT_ID` is set

## Automation Boundary

The Telegram Bot API cannot synthesize real inbound user messages, group mentions, replies, or file uploads. Those checks must be run by an operator from Telegram clients or through a separate user-account test harness that is intentionally outside this bot.

Automated in this repo:

- token-free configuration preflight
- Telegram `getMe`
- optional Telegram outbound `sendMessage`
- migrations and local health counters
- default auth profile presence
- optional MTProto user-account smoke messages through `pnpm smoke:telegram-user`
- repeatable live validation matrix through `pnpm smoke:suite`
- explicitly confirmed disposable GitHub issue/comment writes through `pnpm smoke:github-write`

Manual or environment-dependent by design:

- inbound private messages without the MTProto user smoke harness or suite
- group mention, reply gating, and file uploads without the MTProto user smoke harness or suite
- `/stop` during a live model turn
- webhook delivery from Telegram to a public endpoint
- live Codex model behavior beyond ordinary prompted replies

## Optional GitHub Write Smoke Harness

GitHub write validation intentionally lives outside the normal live suite because it creates real GitHub data. Use only a disposable repository or disposable issue/PR.

Dry-run plan:

```bash
MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN=true \
MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY=owner/disposable-repo \
pnpm smoke:github-write
```

Live issue creation and issue comment:

```bash
MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN=false \
MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM=create-live-github-issue \
MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY=owner/disposable-repo \
MOTTBOT_GITHUB_WRITE_SMOKE_LABELS=smoke \
pnpm smoke:github-write
```

Optional pull request comment validation:

```bash
export MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER=<disposable-pr-number>
```

The harness uses the same side-effect registry, approval store, request fingerprinting, and `mottbot_github_*` handlers that the model uses at runtime. It uses the host `gh` CLI for auth; Mottbot does not store GitHub tokens.

## Optional User-Account Smoke Harness

The Telegram Bot API cannot send messages as a real user. For repeatable private-chat checks, the repo includes an operator-only MTProto harness:

```bash
pnpm smoke:telegram-user
```

Required Telegram user API credentials:

```bash
export TELEGRAM_API_ID=<api-id-from-my.telegram.org>
export TELEGRAM_API_HASH=<api-hash-from-my.telegram.org>
export MOTTBOT_LIVE_BOT_USERNAME=StartupMottBot
```

First login also needs the Telegram phone number and login code. You can provide them interactively, or through environment variables for one run:

```bash
export TELEGRAM_PHONE_NUMBER=+15555555555
export TELEGRAM_LOGIN_CODE=12345
export TELEGRAM_2FA_PASSWORD=optional-account-2fa-password
```

The harness stores a reusable MTProto string session at:

```text
./data/telegram-user-smoke.session
```

That session file is ignored by git and must be treated like account access. It is optional local smoke-test state, not production bot data. Delete it when you no longer need CLI-driven Telegram validation, but expect the next smoke run to require Telegram login again. Do not commit it, paste it into chat, or reuse it outside this local test harness.

Default behavior:

- sends `Use your health snapshot tool and tell me the current status.` to the configured bot
- waits up to 90 seconds for a non-placeholder bot reply that stays unchanged for 4 seconds
- prints token-free JSON with the sent message ID and reply text

Useful overrides:

```bash
export MOTTBOT_USER_SMOKE_MESSAGE="hello from the MTProto smoke test"
export MOTTBOT_USER_SMOKE_TARGET=StartupMottBot
export MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE=false
export MOTTBOT_USER_SMOKE_FILE_PATH=/absolute/path/to/test-image.png
export MOTTBOT_USER_SMOKE_FORCE_DOCUMENT=false
export MOTTBOT_USER_SMOKE_TIMEOUT_MS=120000
export MOTTBOT_USER_SMOKE_POLL_INTERVAL_MS=2000
export MOTTBOT_USER_SMOKE_STABLE_REPLY_MS=4000
export MOTTBOT_USER_SMOKE_WAIT_FOR_REPLY=true
export MOTTBOT_USER_SMOKE_SESSION_PATH=./data/telegram-user-smoke.session
```

This harness is intentionally separate from the bot runtime. Use it only with your own Telegram account and controlled test bots.

The same harness can drive several previously manual private-chat and group checks:

- private chat: leave `MOTTBOT_USER_SMOKE_TARGET` unset or set it to the bot username
- group mention: set `MOTTBOT_USER_SMOKE_TARGET` to the group entity and include `@<bot username>` in `MOTTBOT_USER_SMOKE_MESSAGE`
- reply-to-bot gating: set `MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE=true`
- file upload: set `MOTTBOT_USER_SMOKE_FILE_PATH` to a local image or document fixture

Webhook delivery still requires a public HTTPS endpoint and Telegram webhook registration. The local harness can validate the conversation once webhook delivery is configured, but it cannot create the public endpoint.

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
| Text-like attachment | Send a `.txt`, `.md`, code, CSV, TSV, or selectable-text PDF file | Attachment is extracted into bounded prompt text for the active run and appears in `/files`. |
| Unsupported binary attachment | Send a `.zip` or invalid binary document | Attachment remains metadata or records an extraction failure without leaking paths, raw bytes, or Telegram file URLs. |

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
- non-image files use bounded prompt text where supported; they are not sent as native provider file blocks until the provider exposes one

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
