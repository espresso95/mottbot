# Mottbot Setup

## Goal

This setup runs Mottbot as a long-lived macOS user service through `launchd`.

The service command keeps secrets out of the LaunchAgent plist. Runtime secrets live in the repo-local `.env` file, which is ignored by git and loaded from the service working directory.

## Current Host Layout

Repository:

```bash
/Users/mottbot/mottbot
```

LaunchAgent label:

```text
ai.mottbot.bot
```

LaunchAgent file:

```text
~/Library/LaunchAgents/ai.mottbot.bot.plist
```

Logs:

```text
~/Library/Logs/mottbot/bot.out.log
~/Library/Logs/mottbot/bot.err.log
```

Service command:

```bash
cd /Users/mottbot/mottbot && <absolute-node> node_modules/tsx/dist/cli.mjs src/index.ts start
```

The generated plist stores the absolute Node binary path from the host that installed the service, so launchd does not depend on interactive shell PATH setup.

## One-Time Setup

Install dependencies:

```bash
corepack pnpm install --frozen-lockfile
```

Create the local secret file:

```bash
cp .env.example .env
chmod 600 .env
```

Fill these values in `.env`:

```bash
TELEGRAM_BOT_TOKEN=<bot token from BotFather>
MOTTBOT_MASTER_KEY=<strong random local secret>
MOTTBOT_ADMIN_USER_IDS=<your Telegram numeric user id>
MOTTBOT_SQLITE_PATH=./data/mottbot.sqlite
MOTTBOT_ATTACHMENT_CACHE_DIR=./data/attachments
MOTTBOT_ATTACHMENT_MAX_FILE_BYTES=20971520
MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES=31457280
MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE=4
MOTTBOT_MAX_INBOUND_TEXT_CHARS=12000
MOTTBOT_TELEGRAM_POLLING=true
MOTTBOT_DASHBOARD_ENABLED=false
MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false
MOTTBOT_AUTO_MEMORY_SUMMARIES=false
```

Do not commit `.env`, SQLite files, logs, or attachment cache data.

Import Codex CLI auth into the configured SQLite database:

```bash
corepack pnpm auth:import-cli
```

Run the guarded preflight:

```bash
MOTTBOT_LIVE_SMOKE_ENABLED=true corepack pnpm smoke:preflight
```

Expected result:

- `telegramBot.username` matches the bot
- `authProfiles` is at least `1`
- `migrations` includes version `1`
- `issues` is empty

Optional private-chat smoke without manually typing in Telegram:

```bash
MOTTBOT_USER_SMOKE_ENABLED=true \
TELEGRAM_API_ID=<api-id-from-my.telegram.org> \
TELEGRAM_API_HASH=<api-hash-from-my.telegram.org> \
MOTTBOT_LIVE_BOT_USERNAME=<bot-username-without-@> \
corepack pnpm smoke:telegram-user
```

The first run logs in with your Telegram user account and stores an ignored session file under `data/`. Treat that session file like account access, do not commit it, and use this harness only with your own Telegram account and a controlled test bot.

For group, reply-gating, or attachment smoke checks, add:

```bash
MOTTBOT_USER_SMOKE_TARGET=<group-or-bot-entity>
MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE=true
MOTTBOT_USER_SMOKE_FILE_PATH=/absolute/path/to/test-file
```

## Install And Start The Persistent Service

Install and start:

```bash
corepack pnpm service install --start
```

Check status:

```bash
corepack pnpm service status
```

Restart from the CLI:

```bash
corepack pnpm run restart
```

Equivalent explicit command:

```bash
corepack pnpm service restart
```

Stop:

```bash
corepack pnpm service stop
```

Start after stopping:

```bash
corepack pnpm service start
```

Uninstall the LaunchAgent:

```bash
corepack pnpm service uninstall
```

## Logs

Watch stderr:

```bash
tail -f ~/Library/Logs/mottbot/bot.err.log
```

Watch stdout:

```bash
tail -f ~/Library/Logs/mottbot/bot.out.log
```

## Telegram Polling Conflict

Telegram allows only one active `getUpdates` poller per bot token.

If logs show:

```text
409: Conflict: terminated by other getUpdates request
```

then another process or host is using the same bot token. The bot now stays alive and retries every 30 seconds, but it cannot receive updates until the other poller stops.

Fix options:

1. Stop the other bot process using this token.
2. Rotate the token in BotFather and update `.env`.
3. Use webhook mode with a public HTTPS URL instead of polling.

After changing the token:

```bash
corepack pnpm run restart
```

## Updating Code

Pull changes and restart:

```bash
git pull
corepack pnpm install --frozen-lockfile
corepack pnpm run restart
```

The service runs from source through `tsx`, so a TypeScript build is not required for the LaunchAgent. Still run checks before or after updates:

```bash
corepack pnpm check
corepack pnpm test
```

## Local Smoke Test

After the service is running:

1. Send `/health` to the bot in a private Telegram chat.
2. Send `hello` to verify a model-backed response.
3. Optionally run `corepack pnpm smoke:telegram-user` with the guarded MTProto environment above to verify inbound private-chat delivery from the CLI.
4. Run:

```bash
corepack pnpm health
```

If `/health` works but model responses fail, inspect:

- Codex CLI auth with `corepack pnpm auth:import-cli`
- `~/Library/Logs/mottbot/bot.err.log`
- `/status` in Telegram

## Security Notes

- Rotate any bot token that has been pasted into chat or logs.
- Keep `.env` permission-restricted with `chmod 600 .env`.
- Keep `MOTTBOT_MASTER_KEY` stable for the same SQLite database. Changing it prevents decrypting existing auth profile tokens.
- Do not run multiple polling instances with the same token.
- Leave `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false` unless you need operator-approved tools such as `mottbot_restart_service`.
