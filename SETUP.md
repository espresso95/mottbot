# Mottbot Setup

## Goal

This setup runs Mottbot as a long-lived macOS user service through `launchd`.

The service command keeps secrets out of the LaunchAgent plist. Runtime secrets live in the repo-local `mottbot.config.json`, which is ignored by git and loaded from the service working directory. `.env` is only for `MOTTBOT_CONFIG_PATH` and delegated tool access tokens referenced by that config.

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

Create the local config and optional env file:

```bash
cp mottbot.config.example.json mottbot.config.json
chmod 600 mottbot.config.json
cp .env.example .env
chmod 600 .env
```

Fill these required values in `mottbot.config.json`:

- `telegram.botToken`: bot token from BotFather
- `telegram.adminUserIds`: your Telegram numeric user ID
- `security.masterKey`: a strong random local secret
- `storage.sqlitePath`: for example `./data/mottbot.sqlite`
- `attachments.cacheDir`: for example `./data/attachments`

Keep `.env` small:

```bash
MOTTBOT_CONFIG_PATH=./mottbot.config.json
MOTTBOT_MICROSOFT_TODO_ACCESS_TOKEN=
MOTTBOT_GOOGLE_DRIVE_ACCESS_TOKEN=
```

Local state:

- `storage.sqlitePath` is the bot's runtime database, not test data. Keep it under an ignored directory such as `data/` so chats, sessions, runs, auth profiles, and queues survive restarts without being committed.
- `attachments.cacheDir` is runtime cache storage for downloaded Telegram attachments. Keep it ignored as well.
- `dist/`, `coverage/`, SQLite files, logs, and Telegram session files are generated local artifacts and must not be committed.
- `memory.candidateExtractionEnabled=true` makes the bot ask the configured model for memory candidates after completed runs. Candidates are not used until accepted with `/memory accept <id-prefix>`.
- `usage` configures optional UTC daily/monthly run caps. Leave all budget values at `0` for no local caps.
- `agents.list` can define named agents and `agents.bindings` can route Telegram chats to them. A binding can include `projectKey` so approved `scope:project:<key>` memory applies to that route. Leave both empty to use the synthesized default agent from `auth.defaultProfile` and `models.default`.
- Agent entries can set `profileId`, `modelRef`, `fastMode`, `systemPrompt`, `toolNames`, `toolPolicies`, `maxConcurrentRuns`, and `maxQueuedRuns`. `toolNames` narrows the tools exposed to that agent; `toolPolicies` narrows the global tool policy for specific tools. Omit run limits for unlimited host-local capacity.
- Owner/admin users can use `/agent list`, `/agent show [agent-id]`, `/agent set <agent-id>`, and `/agent reset` in Telegram. Agent set/reset validates the profile, chat model policy, and local usage budget before changing the route. Use `/debug agents` or the dashboard Agents panel to inspect route counts, run counts, configured limits, and stale persisted agent IDs.

Reaction settings:

- `telegram.reactions.ackEmoji` is sent after a message is accepted for model handling.
- `telegram.reactions.notifications=own` records reactions only on bot-authored messages; use `all` only for trusted chats.
- `telegram.reactions.removeAckAfterReply=true` clears the bot's reaction on the triggering message after the run finishes.

File understanding settings:

- text, Markdown, code, CSV, TSV, and PDF documents are downloaded within the existing attachment byte limits
- extracted text is sent only to the active model run; SQLite stores metadata and extraction summaries, not raw file contents
- `attachments.maxExtractedTextCharsPerFile` and `attachments.maxExtractedTextCharsTotal` bound prompt text from files
- `attachments.csvPreviewRows` and `attachments.csvPreviewColumns` bound table previews
- `attachments.pdfMaxPages` bounds PDF text extraction
- use `/files` in Telegram to list recent files for the current session and `/files forget <id-prefix>` or `/files clear` to remove retained file metadata

Tool policy settings:

- `tools.policies` is optional JSON for enabled tool policy overrides
- policy fields are `allowedRoles`, `allowedChatIds`, `requiresApproval`, `dryRun`, and `maxOutputBytes`
- leave it as `{}` for conservative defaults
- side-effecting tool calls generate sanitized approval previews and request fingerprints before execution
- side-effecting tools always require one-shot approval for real execution; use `dryRun:true` for preview-only validation
- use `/tool audit [limit] [here] [tool:<name>] [code:<decision>]` as an admin to inspect bounded tool policy and approval audit records

Example:

```json
{
  "tools": {
    "policies": {
      "mottbot_health_snapshot": {
        "allowedRoles": ["owner", "admin", "trusted", "user"],
        "maxOutputBytes": 4000
      }
    }
  }
}
```

User role and chat policy setup:

- `telegram.adminUserIds` is the bootstrap owner list; these users cannot be revoked from Telegram commands
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

- `tools.repository.roots=["."]` approves the current checkout for read-only admin model tools
- add more entries for multiple approved roots
- `tools.repository.deniedPaths` adds extra denied path segments or relative paths
- default denied paths include `.env`, `.env.*`, `mottbot.config.json`, `auth.json`, `.local`, `.codex`, `.git`, `node_modules`, `data`, `dist`, `coverage`, SQLite/database files, logs, and Telegram session files
- repository tools are admin-only and read-only; they can list files, read bounded text slices, search literal text, and inspect git status/branch/commits/diffs

Local write tool settings:

- `tools.localWrite.roots=["./data/tool-notes"]` approves where the model can create, read, append, or replace `.md` and `.txt` documents
- `tools.localWrite.deniedPaths` adds extra denied path segments or relative paths
- `tools.localWrite.maxWriteBytes=20000` caps each read or write result
- local document tools reject traversal and symlink escapes
- `mottbot_local_note_create` is create-only
- `mottbot_local_doc_replace` requires the SHA-256 returned by `mottbot_local_doc_read`, so stale edits are rejected
- write tools do not return written content in tool output

Local command execution settings:

- `tools.localExec.roots=["./data/tool-workspace"]` approves where commands can run
- `tools.localExec.deniedPaths` adds extra denied cwd path segments or relative paths
- `tools.localExec.allowedCommands` must list exact commands or executable basenames before any command can run
- `tools.localExec.timeoutMs=5000` caps runtime
- `tools.localExec.maxOutputBytes=40000` caps stdout and stderr returned to the model
- commands run without shell expansion, with ignored stdin and a minimal environment
- shells and privilege-changing commands are denied even if accidentally configured

Codex CLI job tools:

- `mottbot_codex_job_start` and `mottbot_codex_job_cancel` are side-effecting admin tools and require one-shot approval
- `mottbot_codex_job_status` and `mottbot_codex_job_tail` are read-only admin tools
- jobs use `codexJobs.repoRoots`, `codexJobs.artifactRoot`, and `codexJobs.codex` settings
- direct tool job state is kept in memory for the current process

MCP bridge settings:

- `tools.mcp.servers` is a JSON array of configured stdio MCP servers
- each entry needs `name`, `command`, optional `args`, and `allowedTools`
- each approved call starts the configured server, initializes it, calls one allowlisted tool, bounds output, and terminates the server process
- unconfigured servers, unallowlisted tools, shells, and privilege-changing commands are denied

Example:

```json
{
  "tools": {
    "mcp": {
      "servers": [
        {
          "name": "docs",
          "command": "node",
          "args": ["./mcp/docs-server.mjs"],
          "allowedTools": ["search", "read"],
          "timeoutMs": 10000,
          "maxOutputBytes": 40000
        }
      ]
    }
  }
}
```

Telegram send tool settings:

- `tools.telegramSend.allowedChatIds` controls cross-chat send targets for `mottbot_telegram_send_message`
- leaving it empty still permits approved sends to the current chat only
- target chat and text are part of the approval fingerprint, so changed arguments require a new approval

Usage budget settings:

- `usage` accepts `dailyRuns`, `dailyRunsPerUser`, `dailyRunsPerChat`, `dailyRunsPerSession`, `dailyRunsPerModel`, `monthlyRuns`, `monthlyRunsPerUser`, `monthlyRunsPerChat`, `monthlyRunsPerSession`, and `monthlyRunsPerModel`
- `usage.warningThresholdPercent=80` controls when a run shows an approaching-limit warning
- budget windows reset at UTC day/month boundaries
- budgets use accepted local run counters as guardrails, not provider billing data
- use `/usage` or `/usage monthly` to inspect local run counts and configured limits

Example:

```json
{
  "usage": {
    "dailyRunsPerUser": 25,
    "dailyRunsPerChat": 100,
    "monthlyRuns": 1000
  }
}
```

GitHub settings:

- install and authenticate the GitHub CLI with `gh auth login`; Mottbot does not store GitHub tokens
- `tools.github.defaultRepository` can pin a default `owner/name`; when empty, Mottbot infers the repository from local `origin`
- `tools.github.command="gh"` points to the host GitHub CLI command
- `tools.github.commandTimeoutMs=10000` bounds each CLI read
- `tools.github.maxItems=10` caps pull request, issue, and workflow result counts
- `tools.github.maxOutputBytes=80000` caps GitHub tool output
- admin Telegram commands: `/github status`, `/github repo`, `/github prs`, `/github issues`, `/github runs`, and `/github failures`
- when side-effect tools are enabled, model-requested issue creation and issue/PR comments use the same `gh` account and still require one-shot admin approval

Import Codex CLI auth into the configured SQLite database:

```bash
corepack pnpm auth:import-cli
```

Smoke commands are optional operator-run checks. Their one-run scenario inputs are CLI flags documented in `docs/live-smoke-tests.md`. For true parallel live Telegram smoke, create one ignored lane config per test bot under `.local/smoke-lanes/` and run through `corepack pnpm smoke:lane`.

Run the guarded preflight:

```bash
corepack pnpm smoke:preflight
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

Run the dashboard smoke validation:

```bash
corepack pnpm smoke:dashboard
```

This starts a temporary loopback dashboard-only server, fetches the dashboard HTML and runtime API, verifies the Agents panel and agent summary payload, then shuts the temporary server down. It does not start a Telegram poller, so it is safe to run while the service is already running. Pass `--port <port>` only when you need a fixed local port.

Dry-run the guarded GitHub write validation:

```bash
corepack pnpm smoke:github-write --repository owner/disposable-repo --dry-run
```

Only run live GitHub write validation against disposable targets. Live writes require `--no-dry-run --confirm create-live-github-issue`.

Run the repeatable suite dry run:

```bash
corepack pnpm smoke:suite --dry-run
```

Run the suite for real:

```bash
corepack pnpm smoke:suite
```

When `--api-id`, `--api-hash`, and `--bot-username` are passed, the suite adds private conversation, `/health`, `/usage`, reply, optional group mention, optional group non-mention, and optional attachment fixture checks on top of preflight.

Run the same suite through an isolated lane config:

```bash
corepack pnpm smoke:lane --lane lane-1 --api-id <api-id> --api-hash <api-hash>
```

Use `corepack pnpm smoke:lane --lane lane-1 --action service-restart` to restart only that lane's launchd service. Each lane must use a different Telegram bot token and `service.label`.

Optional private-chat smoke without manually typing in Telegram:

```bash
corepack pnpm smoke:telegram-user \
  --api-id <api-id-from-my.telegram.org> \
  --api-hash <api-hash-from-my.telegram.org> \
  --bot-username <bot-username-without-@>
```

The first run logs in with your Telegram user account and stores an ignored session file under `data/`. This file is optional and only supports the local smoke harness; the production bot does not need it. Treat it like account access, do not commit it, and use this harness only with your own Telegram account and a controlled test bot.

For group, reply-gating, or attachment smoke checks, add:

```bash
--target <group-or-bot-entity>
--reply-to-latest-bot-message
--file-path /absolute/path/to/test-file
--no-expect-reply
--expect-reply-contains <unique-fixture-phrase>
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
4. Copy `<backup-dir>/mottbot.sqlite` into the configured `storage.sqlitePath`.
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
2. Rotate the token in BotFather and update `telegram.botToken` in `mottbot.config.json`.
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
corepack pnpm verify
```

## Local Smoke Test

After the service is running:

1. Send `/health` to the bot in a private Telegram chat.
2. Send `hello` to verify a model-backed response.
3. Optionally run `corepack pnpm smoke:telegram-user` with the guarded MTProto flags above to verify inbound private-chat delivery from the CLI.
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
- Keep `mottbot.config.json` and `.env` permission-restricted with `chmod 600`.
- Keep `security.masterKey` stable for the same SQLite database. Changing it prevents decrypting existing auth profile tokens.
- Do not run multiple polling instances with the same token.
- Leave `tools.enableSideEffectTools=false` unless you need admin-only, operator-approved tools such as local document writes, allowlisted local command execution, MCP stdio calls, Telegram send/reaction, or delayed restart.
