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
MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE=40000
MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL=80000
MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS=40
MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS=20
MOTTBOT_ATTACHMENT_PDF_MAX_PAGES=25
MOTTBOT_MAX_INBOUND_TEXT_CHARS=12000
MOTTBOT_TELEGRAM_POLLING=true
MOTTBOT_TELEGRAM_REACTIONS_ENABLED=true
MOTTBOT_TELEGRAM_ACK_REACTION=👀
MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY=false
MOTTBOT_TELEGRAM_REACTION_NOTIFICATIONS=own
MOTTBOT_DASHBOARD_ENABLED=false
MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false
MOTTBOT_TOOL_POLICIES_JSON=
MOTTBOT_REPOSITORY_ROOTS=.
MOTTBOT_REPOSITORY_DENIED_PATHS=
MOTTBOT_REPOSITORY_MAX_READ_BYTES=40000
MOTTBOT_REPOSITORY_MAX_SEARCH_MATCHES=100
MOTTBOT_REPOSITORY_MAX_SEARCH_BYTES=80000
MOTTBOT_REPOSITORY_COMMAND_TIMEOUT_MS=5000
MOTTBOT_LOCAL_WRITE_ROOTS=./data/tool-notes
MOTTBOT_LOCAL_WRITE_DENIED_PATHS=
MOTTBOT_LOCAL_WRITE_MAX_BYTES=20000
MOTTBOT_LOCAL_EXEC_ROOTS=./data/tool-workspace
MOTTBOT_LOCAL_EXEC_DENIED_PATHS=
MOTTBOT_LOCAL_EXEC_ALLOWED_COMMANDS=
MOTTBOT_LOCAL_EXEC_TIMEOUT_MS=5000
MOTTBOT_LOCAL_EXEC_MAX_OUTPUT_BYTES=40000
MOTTBOT_MCP_SERVERS_JSON=
MOTTBOT_GITHUB_REPOSITORY=
MOTTBOT_GITHUB_COMMAND=gh
MOTTBOT_GITHUB_COMMAND_TIMEOUT_MS=10000
MOTTBOT_GITHUB_MAX_ITEMS=10
MOTTBOT_GITHUB_MAX_OUTPUT_BYTES=80000
MOTTBOT_AUTO_MEMORY_SUMMARIES=false
MOTTBOT_AUTO_MEMORY_SUMMARY_RECENT_MESSAGES=12
MOTTBOT_AUTO_MEMORY_SUMMARY_MAX_CHARS=1000
MOTTBOT_MEMORY_CANDIDATES_ENABLED=false
MOTTBOT_MEMORY_CANDIDATE_RECENT_MESSAGES=12
MOTTBOT_MEMORY_CANDIDATE_MAX_PER_RUN=5
MOTTBOT_USAGE_BUDGETS_JSON=
MOTTBOT_USAGE_WARNING_THRESHOLD_PERCENT=80
```

Local state:

- `MOTTBOT_SQLITE_PATH` is the bot's runtime database, not test data. Keep it under an ignored directory such as `data/` so chats, sessions, runs, auth profiles, and queues survive restarts without being committed.
- `MOTTBOT_ATTACHMENT_CACHE_DIR` is runtime cache storage for downloaded Telegram attachments. Keep it ignored as well.
- `dist/`, `coverage/`, SQLite files, logs, and Telegram session files are generated local artifacts and must not be committed.
- `MOTTBOT_MEMORY_CANDIDATES_ENABLED=true` makes the bot ask the configured model for memory candidates after completed runs. Candidates are not used until accepted with `/memory accept <id-prefix>`.
- `MOTTBOT_USAGE_BUDGETS_JSON` configures optional UTC daily/monthly run caps. Leave it empty for no local caps.

Reaction settings:

- `MOTTBOT_TELEGRAM_ACK_REACTION` is sent after a message is accepted for model handling.
- `MOTTBOT_TELEGRAM_REACTION_NOTIFICATIONS=own` records reactions only on bot-authored messages; use `all` only for trusted chats.
- `MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY=true` clears the bot's reaction on the triggering message after the run finishes.

File understanding settings:

- text, Markdown, code, CSV, TSV, and PDF documents are downloaded within the existing attachment byte limits
- extracted text is sent only to the active model run; SQLite stores metadata and extraction summaries, not raw file contents
- `MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE` and `MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL` bound prompt text from files
- `MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS` and `MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS` bound table previews
- `MOTTBOT_ATTACHMENT_PDF_MAX_PAGES` bounds PDF text extraction
- use `/files` in Telegram to list recent files for the current session and `/files forget <id-prefix>` or `/files clear` to remove retained file metadata

Tool policy settings:

- `MOTTBOT_TOOL_POLICIES_JSON` is optional JSON for enabled tool policy overrides
- policy fields are `allowedRoles`, `allowedChatIds`, `requiresApproval`, `dryRun`, and `maxOutputBytes`
- leave it empty for conservative defaults
- side-effecting tool calls generate sanitized approval previews and request fingerprints before execution
- side-effecting tools always require one-shot approval for real execution; use `dryRun:true` for preview-only validation
- use `/tool audit [limit] [here] [tool:<name>] [code:<decision>]` as an admin to inspect bounded tool policy and approval audit records

Example:

```bash
MOTTBOT_TOOL_POLICIES_JSON='{"mottbot_health_snapshot":{"allowedRoles":["owner","admin","trusted","user"],"maxOutputBytes":4000}}'
```

User role and chat policy setup:

- `MOTTBOT_ADMIN_USER_IDS` is the bootstrap owner list; these users cannot be revoked from Telegram commands
- use `/users me` to confirm your role after the bot starts
- use `/users grant <user-id> <owner|admin|trusted> [reason]` from an owner chat to add another operator
- use `/users revoke <user-id> [reason]` to remove a database-backed role
- use `/users list` and `/users audit [limit]` to inspect the current role state and recent changes

Per-chat policy is stored in SQLite and managed from Telegram:

```text
/users chat show [chat-id]
/users chat set [chat-id] <json>
/users chat clear [chat-id]
```

Example policy for a group that lets trusted users run only help/status, limits models and tools, and keeps attachment use small:

```json
{
  "allowedRoles": ["owner", "admin", "trusted"],
  "commandRoles": {
    "help": ["trusted"],
    "status": ["trusted"]
  },
  "modelRefs": ["openai-codex/gpt-5.4-mini"],
  "toolNames": ["mottbot_health_snapshot"],
  "memoryScopes": ["session", "personal"],
  "attachmentMaxPerMessage": 2,
  "attachmentMaxFileBytes": 5242880
}
```

Repository tool settings:

- `MOTTBOT_REPOSITORY_ROOTS=.` approves the current checkout for read-only admin model tools
- use a comma-separated list for multiple approved roots
- `MOTTBOT_REPOSITORY_DENIED_PATHS` adds extra denied path segments or relative paths
- default denied paths include `.env`, `.env.*`, `mottbot.config.json`, `auth.json`, `.codex`, `.git`, `node_modules`, `data`, `dist`, `coverage`, SQLite/database files, logs, and Telegram session files
- repository tools are admin-only and read-only; they can list files, read bounded text slices, search literal text, and inspect git status/branch/commits/diffs

Local write tool settings:

- `MOTTBOT_LOCAL_WRITE_ROOTS=./data/tool-notes` approves where the model can create, read, append, or replace `.md` and `.txt` documents
- `MOTTBOT_LOCAL_WRITE_DENIED_PATHS` adds extra denied path segments or relative paths
- `MOTTBOT_LOCAL_WRITE_MAX_BYTES=20000` caps each read or write result
- local document tools reject traversal and symlink escapes
- `mottbot_local_note_create` is create-only
- `mottbot_local_doc_replace` requires the SHA-256 returned by `mottbot_local_doc_read`, so stale edits are rejected
- write tools do not return written content in tool output

Local command execution settings:

- `MOTTBOT_LOCAL_EXEC_ROOTS=./data/tool-workspace` approves where commands can run
- `MOTTBOT_LOCAL_EXEC_DENIED_PATHS` adds extra denied cwd path segments or relative paths
- `MOTTBOT_LOCAL_EXEC_ALLOWED_COMMANDS` must list exact commands or executable basenames before any command can run
- `MOTTBOT_LOCAL_EXEC_TIMEOUT_MS=5000` caps runtime
- `MOTTBOT_LOCAL_EXEC_MAX_OUTPUT_BYTES=40000` caps stdout and stderr returned to the model
- commands run without shell expansion, with ignored stdin and a minimal environment
- shells and privilege-changing commands are denied even if accidentally configured

MCP bridge settings:

- `MOTTBOT_MCP_SERVERS_JSON` is a JSON array of configured stdio MCP servers
- each entry needs `name`, `command`, optional `args`, and `allowedTools`
- each approved call starts the configured server, initializes it, calls one allowlisted tool, bounds output, and terminates the server process
- unconfigured servers, unallowlisted tools, shells, and privilege-changing commands are denied

Example:

```bash
MOTTBOT_MCP_SERVERS_JSON='[{"name":"docs","command":"node","args":["./mcp/docs-server.mjs"],"allowedTools":["search","read"],"timeoutMs":10000,"maxOutputBytes":40000}]'
```

Telegram send tool settings:

- `MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS=` controls cross-chat send targets for `mottbot_telegram_send_message`
- leaving it empty still permits approved sends to the current chat only
- target chat and text are part of the approval fingerprint, so changed arguments require a new approval

Usage budget settings:

- `MOTTBOT_USAGE_BUDGETS_JSON` accepts `dailyRuns`, `dailyRunsPerUser`, `dailyRunsPerChat`, `dailyRunsPerSession`, `dailyRunsPerModel`, `monthlyRuns`, `monthlyRunsPerUser`, `monthlyRunsPerChat`, `monthlyRunsPerSession`, and `monthlyRunsPerModel`
- `MOTTBOT_USAGE_WARNING_THRESHOLD_PERCENT=80` controls when a run shows an approaching-limit warning
- budget windows reset at UTC day/month boundaries
- budgets use accepted local run counters as guardrails, not provider billing data
- use `/usage` or `/usage monthly` to inspect local run counts and configured limits

Example:

```bash
MOTTBOT_USAGE_BUDGETS_JSON='{"dailyRunsPerUser":25,"dailyRunsPerChat":100,"monthlyRuns":1000}'
```

GitHub settings:

- install and authenticate the GitHub CLI with `gh auth login`; Mottbot does not store GitHub tokens
- `MOTTBOT_GITHUB_REPOSITORY=` can pin a default `owner/name`; when empty, Mottbot infers the repository from local `origin`
- `MOTTBOT_GITHUB_COMMAND=gh` points to the host GitHub CLI command
- `MOTTBOT_GITHUB_COMMAND_TIMEOUT_MS=10000` bounds each CLI read
- `MOTTBOT_GITHUB_MAX_ITEMS=10` caps pull request, issue, and workflow result counts
- `MOTTBOT_GITHUB_MAX_OUTPUT_BYTES=80000` caps GitHub tool output
- admin Telegram commands: `/github status`, `/github repo`, `/github prs`, `/github issues`, `/github runs`, and `/github failures`
- when side-effect tools are enabled, model-requested issue creation and issue/PR comments use the same `gh` account and still require one-shot admin approval

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

Run the disposable local tool validation:

```bash
corepack pnpm smoke:local-tools
```

This creates temp roots, exercises approved local document append/replace, allowlisted local command execution, and a configured test MCP stdio call through the real tool executor and approval path, then removes the temp files. It does not send Telegram messages or use production tool roots.

Dry-run the guarded GitHub write validation:

```bash
MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED=true \
MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN=true \
MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY=owner/disposable-repo \
corepack pnpm smoke:github-write
```

Only run live GitHub write validation against disposable targets. Live writes require `MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM=create-live-github-issue`.

Run the repeatable suite dry run:

```bash
MOTTBOT_LIVE_VALIDATION_ENABLED=true \
MOTTBOT_LIVE_VALIDATION_DRY_RUN=true \
corepack pnpm smoke:suite
```

Run the suite for real:

```bash
MOTTBOT_LIVE_VALIDATION_ENABLED=true corepack pnpm smoke:suite
```

When `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `MOTTBOT_LIVE_BOT_USERNAME` are configured, the suite adds private conversation, `/health`, `/usage`, reply, optional group mention, and optional attachment fixture checks on top of preflight.

Optional private-chat smoke without manually typing in Telegram:

```bash
MOTTBOT_USER_SMOKE_ENABLED=true \
TELEGRAM_API_ID=<api-id-from-my.telegram.org> \
TELEGRAM_API_HASH=<api-hash-from-my.telegram.org> \
MOTTBOT_LIVE_BOT_USERNAME=<bot-username-without-@> \
corepack pnpm smoke:telegram-user
```

The first run logs in with your Telegram user account and stores an ignored session file under `data/`. This file is optional and only supports the local smoke harness; the production bot does not need it. Treat it like account access, do not commit it, and use this harness only with your own Telegram account and a controlled test bot.

For group, reply-gating, or attachment smoke checks, add:

```bash
MOTTBOT_USER_SMOKE_TARGET=<group-or-bot-entity>
MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE=true
MOTTBOT_USER_SMOKE_FILE_PATH=/absolute/path/to/test-file
```

Recommended file fixtures for live validation:

- `.txt` or `.md` file with short UTF-8 text
- `.pdf` with selectable text
- `.ts` or `.py` source file
- `.csv` with a header and a few rows
- unsupported binary such as a `.zip`

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

## Backups And Restore Validation

Create a local backup:

```bash
corepack pnpm backup create
```

The command writes a timestamped directory under `data/backups/` by default. It includes:

- a SQLite online backup at `mottbot.sqlite`
- source `-wal` and `-shm` sidecar files when present
- `config.redacted.json`
- `manifest.json` with file sizes and SHA-256 checksums

`.env` is excluded by default. Include it only for a private host-local backup:

```bash
corepack pnpm backup create --include-env
```

Validate a backup before restore:

```bash
corepack pnpm backup validate data/backups/<backup-dir>
```

Dry-run a restore target check:

```bash
corepack pnpm backup validate data/backups/<backup-dir> --target-sqlite data/mottbot.sqlite
```

Restore runbook:

1. Stop the service with `corepack pnpm service stop`.
2. Validate the backup with `corepack pnpm backup validate <backup-dir> --target-sqlite data/mottbot.sqlite`.
3. Move the existing database and sidecars aside instead of deleting them.
4. Copy `<backup-dir>/mottbot.sqlite` into the configured `MOTTBOT_SQLITE_PATH`.
5. Recreate `.env` separately unless the backup was intentionally made with `--include-env`.
6. Run `corepack pnpm db migrate`.
7. Start the service with `corepack pnpm service start`.
8. Confirm `corepack pnpm health` reports `Status: ok`.

## Logs

Watch stderr:

```bash
tail -f ~/Library/Logs/mottbot/bot.err.log
```

Watch stdout:

```bash
tail -f ~/Library/Logs/mottbot/bot.out.log
```

Show log sizes:

```bash
corepack pnpm logs status
```

Archive logs without truncating active files:

```bash
corepack pnpm logs rotate
```

Archive and truncate launchd log files:

```bash
corepack pnpm logs rotate --truncate --max-archives 10
```

Rotated logs are written under `~/Library/Logs/mottbot/archive/` by default. The command skips missing files and symlinks instead of truncating an unexpected target.

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
- Leave `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false` unless you need admin-only, operator-approved tools such as local document writes, allowlisted local command execution, MCP stdio calls, Telegram send/reaction, or delayed restart.
