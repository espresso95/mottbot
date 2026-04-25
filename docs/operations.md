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
pnpm install --frozen-lockfile
```

If pnpm 10 blocks native dependency build scripts on a fresh checkout, approve the workspace builds or rebuild `better-sqlite3` before running tests or starting the bot:

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

2. Create configuration:

- copy `mottbot.config.example.json` to `mottbot.config.json`
- set `telegram.botToken`
- set `security.masterKey`

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

- `telegram.polling=false`
- `telegram.webhook.publicUrl`
- optional webhook `path`, `host`, `port`, and `secretToken` overrides

## Test Environment Checklist

Use a private operator-only test environment before live validation.

Required items:

- a Telegram bot token from BotFather stored in `telegram.botToken`
- a strong local secret in `security.masterKey`
- the owner's Telegram user ID in `telegram.adminUserIds`
- optional test chat IDs in `telegram.allowedChatIds`
- a runtime SQLite path such as `storage.sqlitePath` (`./data/mottbot.sqlite`)
- a separate live-integration SQLite path such as `./data/mottbot.integration.sqlite` when validating without touching runtime data
- a unique `service.label` and SQLite/session paths for each parallel live-smoke lane
- a Codex auth source, either `$CODEX_HOME/auth.json` for CLI import or local OAuth through `pnpm auth:login`
- webhook public URL and secret token values when testing webhook mode

Bot setup and teardown:

- create a test bot with BotFather and keep the token out of git
- add the bot only to private test chats or controlled test groups
- revoke or rotate the token in BotFather after test environments are retired

Secret handling:

- never commit `.env`, `mottbot.config.json`, SQLite files, WAL files, Codex auth files, Telegram tokens, OAuth access tokens, OAuth refresh tokens, or dashboard auth tokens
- keep development and live-integration SQLite files separate so destructive recovery tests cannot affect normal local state
- prefer temporary test chats for webhook and restart-recovery validation

## Dashboard Operations

The runtime can expose a local dashboard for health checks and easier file-backed configuration.

Default endpoint:

- `http://127.0.0.1:8787/dashboard`

Dashboard config keys:

- `dashboard.enabled`
- `dashboard.host`
- `dashboard.port`
- `dashboard.path`
- `dashboard.apiPath`
- `dashboard.authToken`

Operational panels:

- runtime health, service status, current process metadata, recent runs, and recent failed runs
- bounded stdout/stderr log excerpts with dashboard-side secret redaction
- enabled tools, model-exposed tools by role, active tool approvals, and recent tool audit rows
- session memory listing, adding, editing, and deleting by session key
- delayed service restart with an explicit `restart` confirmation

Operational notes:

- dashboard writes updates to the configured config path (default: `mottbot.config.json`, overridden by `MOTTBOT_CONFIG_PATH`)
- runtime configuration values come from the config file; `.env` is only loaded for `MOTTBOT_CONFIG_PATH` and delegated access-token variables referenced by the config
- restart the process after saving config updates
- non-loopback dashboard binding requires `dashboard.authToken`
- service restart from the dashboard requires `dashboard.authToken` even on loopback
- dashboard API responses redact token-like strings, but operators should still avoid putting secrets in memory entries, tool reasons, or logs

## CLI Entry Points

The binary exposes these commands:

```text
mottbot start
mottbot auth login
mottbot auth import-cli
mottbot db migrate
mottbot db prune --older-than-days 30 --dry-run
```

Equivalent `pnpm` scripts:

- `pnpm dev`
- `pnpm build`
- `pnpm start`
- `pnpm check`
- `pnpm check:src`
- `pnpm check:scripts`
- `pnpm lint`
- `pnpm format:check`
- `pnpm tsdoc:audit`
- `pnpm docs:check`
- `pnpm knip`
- `pnpm verify`
- `pnpm verify:quick`
- `pnpm verify:static`
- `pnpm test`
- `pnpm test:changed`
- `pnpm test:coverage`
- `pnpm test:coverage:html`
- `pnpm auth:login`
- `pnpm auth:import-cli`
- `pnpm db:migrate`
- `pnpm db:prune`
- `pnpm health`
- `pnpm service install --start`
- `pnpm service status`
- `pnpm run restart`
- `pnpm smoke:preflight`
- `pnpm smoke:telegram-user`
- `pnpm smoke:dashboard`
- `pnpm smoke:local-tools`
- `pnpm smoke:github-write`
- `pnpm smoke:lane`
- `pnpm smoke:suite`

## Release Verification

The CI workflow in `.github/workflows/ci.yml` is the release-readiness gate for normal pull requests and pushes to `main`.

CI checks:

- dependency installation with the pinned pnpm version
- native `better-sqlite3` rebuild
- `pnpm verify`, covering script typecheck, ESLint, Prettier, strict TSDoc, docs links, dependency-cycle checks, Knip, TypeScript build typecheck/output, and coverage thresholds from `vitest.config.ts`
- package metadata and built CLI health command with a temporary file-backed config
- clean worktree after verification

Use `pnpm verify:quick` for local iteration when you need the static checks without the slower build and coverage run. For test iteration against current branch changes, use targeted Vitest files or `pnpm test:changed`; reserve `pnpm test:coverage:html` for browser-based coverage inspection.

Local equivalent:

```bash
corepack pnpm verify

tmp_config="$(mktemp /tmp/mottbot-release-check.XXXXXX.json)"
node - "$tmp_config" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(
  process.argv[2],
  JSON.stringify(
    {
      telegram: {
        botToken: "local-check",
        polling: false,
        adminUserIds: ["local-check"],
      },
      auth: {
        preferCliImport: false,
      },
      storage: {
        sqlitePath: "/tmp/mottbot-release-check.sqlite",
      },
      dashboard: {
        enabled: false,
      },
      runtime: {
        instanceLeaseEnabled: false,
      },
      security: {
        masterKey: "local-check",
      },
    },
    null,
    2,
  ),
);
NODE
MOTTBOT_CONFIG_PATH="$tmp_config" node dist/index.js health
rm -f "$tmp_config"
corepack pnpm smoke:preflight
```

No CI secrets are required for the default gate. Live Telegram and live Codex checks remain operator-triggered with the smoke CLI flags described in `docs/live-smoke-tests.md`. Smoke harness code lives under `scripts/smoke/`; those inputs are not runtime configuration.

`pnpm smoke:local-tools` creates disposable temp roots, drives the real tool executor and approval path, validates local document append/replace, allowlisted local command execution, and a configured test MCP stdio call, then removes the temp files. It does not send Telegram messages or use production tool roots.

`pnpm smoke:telegram-callbacks` drives tool approve, tool deny, and memory-candidate accept callback handlers in process against a temporary SQLite database. It verifies callback source-message edits, stale keyboard cleanup, audit writes, and memory acceptance without live Telegram access.

`pnpm smoke:github-write` validates approval-gated GitHub issue creation and issue/PR comments through the host `gh` CLI. Start with `--repository owner/disposable-repo --dry-run`; live writes require `--no-dry-run --confirm create-live-github-issue` and should target only a disposable repository or disposable issue/PR.

`pnpm smoke:suite` composes preflight and optional MTProto user-account checks into a repeatable live validation matrix. `--dry-run` prints the planned checks without sending messages.

`pnpm smoke:telegram-user` is an optional MTProto user-account harness for private-chat live validation. It requires `--api-id` and `--api-hash` from `my.telegram.org`, logs in as the operator's Telegram user, stores an ignored session file under `data/` to avoid repeated login prompts, and must not be used in CI. This session file is only for the smoke harness; the bot runtime does not depend on it.

The harness also accepts `--target`, `--reply-to-latest-bot-message`, and `--file-path` for group, reply-gating, and attachment smoke checks.

`pnpm smoke:lane --lane <name>` runs doctor, preflight, suite, telegram-user, or service actions through `.local/smoke-lanes/<name>.json`. Use it when multiple worktrees need live Telegram smoke at the same time. Each lane must use a different Telegram bot token, `service.label`, dashboard port, SQLite path, Codex job artifact root, and smoke session path. Run `pnpm smoke:lane --lane <name> --action doctor` first for local token-free isolation checks. Relative paths in lane configs resolve from the worktree where the command runs.

## User Roles And Chat Governance

`telegram.adminUserIds` is the bootstrap owner list. These users resolve as protected owners and cannot be revoked from Telegram commands. Additional roles are stored in SQLite:

- `owner`: full recovery and role-management authority
- `admin`: operator authority for diagnostics, GitHub status, tool approvals, and audit reads
- `trusted`: normal chat use plus any per-chat command permissions granted by policy
- `user`: default role for unknown callers

Telegram governance commands:

- `/users me` shows the caller role
- `/users list` lists configured and database roles for owner/admin callers
- `/users grant <user-id> <owner|admin|trusted> [reason]` grants a database role for owner callers
- `/users revoke <user-id> [reason]` revokes a database role for owner callers
- `/users audit [limit]` shows bounded role and chat-policy audit records for owner/admin callers
- `/users chat show [chat-id]` displays a chat policy
- `/users chat set [chat-id] <json>` sets a chat policy for owner callers
- `/users chat clear [chat-id]` clears a chat policy for owner callers

Example chat policy:

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

Operational notes:

- owners and admins can still run governance commands if a bad chat policy would otherwise block recovery
- non-operator group commands require an explicit `commandRoles` entry for that command or wildcard
- model tool declarations are filtered by global tool policy, selected-agent restrictions, and per-chat `toolNames`; execution is rechecked before handlers run
- selected-agent and per-chat `toolNames` may use exact tool names or group selectors such as `group:fs`, `group:web`, `group:runtime`, `group:sessions`, `group:automation`, `group:media`, and `group:openclaw`
- `/model` refuses a model not listed in `modelRefs` when a chat policy sets that list
- `/remember` and memory candidate acceptance refuse scopes not listed in `memoryScopes`
- selected-agent `maxConcurrentRuns` caps active execution across sessions on this host, and `maxQueuedRuns` rejects new work with a failed-run Telegram status when the persisted backlog for that agent is full
- `/debug agents`, the dashboard runtime API, and the dashboard Agents panel show configured agent limits, selected route counts, queued runs, active runs, and stale agent IDs left behind after config edits

## Operator Tools

Read-only tools are always deny-by-default and registry scoped. Enabled read-only tools:

- `mottbot_health_snapshot`: token-free runtime counters
- `mottbot_service_status`: local launchd service status
- `mottbot_recent_runs`: recent run records from SQLite
- `mottbot_recent_errors`: failed/cancelled runs plus recent stderr lines
- `mottbot_recent_logs`: recent launchd stdout/stderr lines
- `mottbot_repo_list_files`: approved-root file listing without contents
- `mottbot_repo_read_file`: bounded text slices from approved files
- `mottbot_repo_search`: bounded literal search across approved files
- `mottbot_git_status`: branch and working-tree status
- `mottbot_git_branch`: current branch or detached commit
- `mottbot_git_recent_commits`: recent commit summaries
- `mottbot_git_diff`: diff stat/summary or bounded selected-file diff
- `mottbot_github_repo`: GitHub repository metadata through `gh`
- `mottbot_github_open_prs`: open pull request summaries
- `mottbot_github_recent_issues`: recent open issue summaries
- `mottbot_github_ci_status`: recent GitHub Actions workflow runs
- `mottbot_github_workflow_failures`: recent failed workflow runs
- `mottbot_ms_todo_lists`: Microsoft To Do list summaries through Microsoft Graph
- `mottbot_ms_todo_tasks`: Microsoft To Do task summaries for one list through Microsoft Graph
- `mottbot_ms_todo_task_get`: one Microsoft To Do task by id through Microsoft Graph
- `mottbot_google_drive_search`: Google Drive file search summaries
- `mottbot_google_drive_get_file`: Google Drive file metadata plus optional inline textual content
- `mottbot_local_doc_read`: bounded `.md` or `.txt` reads from approved local-write roots with SHA-256 output for safe edits
- `mottbot_process_list`: bounded local process list
- `mottbot_sessions_list`: recent Mottbot session routes
- `mottbot_session_history`: bounded transcript history for one session
- `mottbot_tool_catalog`: enabled and disabled tool catalog, side effects, and group mappings
- `mottbot_extension_catalog`: configured extension and MCP bridge hints
- `mottbot_extension_manifest_read`: bounded local extension manifest read through repository scope
- `mottbot_automation_tasks`: local automation task artifacts created by tools

The diagnostics, repository, git, GitHub, and local document read tools are read-only but admin-only, because logs, run records, source files, diffs, private repository metadata, CI output, and operator documents can contain operational context.

Repository tools are scoped by:

```json
{
  "tools": {
    "repository": {
      "roots": ["."],
      "deniedPaths": [],
      "maxReadBytes": 40000,
      "maxSearchMatches": 100,
      "maxSearchBytes": 80000,
      "commandTimeoutMs": 5000
    }
  }
}
```

Default denied paths include `.env`, `.env.*`, `mottbot.config.json`, `auth.json`, `.local`, `.codex`, `.git`, `node_modules`, `data`, `dist`, `coverage`, database files, logs, and Telegram session files. Add entries to `tools.repository.deniedPaths` for project-specific private paths.

GitHub tools use the host GitHub CLI. Authenticate once with `gh auth login`; Mottbot does not store GitHub tokens. Public repositories need ordinary read access; private repositories and workflow inspection require the host `gh` account to have repository and Actions read permissions. Approval-gated issue creation and issue/PR comments require the same host account to have write permission on the target repository.

```json
{
  "tools": {
    "github": {
      "defaultRepository": "",
      "command": "gh",
      "commandTimeoutMs": 10000,
      "maxItems": 10,
      "maxOutputBytes": 80000
    }
  }
}
```

When `tools.github.defaultRepository` is empty, Mottbot infers the default repository from local `origin`. Use `/github status`, `/github repo`, `/github prs`, `/github issues`, `/github runs`, or `/github failures` from an admin Telegram chat for direct read-only status.

Microsoft To Do tools call Microsoft Graph with a delegated bearer token provided by the host environment. Mottbot does not run an OAuth login flow for Graph.

```json
{
  "tools": {
    "microsoftTodo": {
      "enabled": false,
      "tenantId": "",
      "clientId": "",
      "graphBaseUrl": "https://graph.microsoft.com/v1.0",
      "accessTokenEnv": "MOTTBOT_MICROSOFT_TODO_ACCESS_TOKEN",
      "defaultListId": "",
      "timeoutMs": 10000,
      "maxItems": 25
    }
  }
}
```

Google Drive tools call Google Drive and Google Docs APIs with a delegated bearer token from the host environment. Mottbot does not run an OAuth flow for Google.

```json
{
  "tools": {
    "googleDrive": {
      "enabled": false,
      "driveBaseUrl": "https://www.googleapis.com/drive/v3",
      "docsBaseUrl": "https://docs.googleapis.com/v1",
      "accessTokenEnv": "MOTTBOT_GOOGLE_DRIVE_ACCESS_TOKEN",
      "timeoutMs": 10000,
      "maxItems": 25,
      "maxBytes": 120000
    }
  }
}
```

Live GitHub write validation is separate from normal startup and intentionally guarded:

```bash
pnpm smoke:github-write --repository owner/disposable-repo --dry-run
```

To perform real writes, pass `--no-dry-run --confirm create-live-github-issue`. The harness creates one disposable issue, comments on it, and optionally comments on `--pr-number` when set.

Side-effecting tools are disabled unless the host explicitly sets:

```json
{
  "tools": {
    "enableSideEffectTools": true
  }
}
```

Current side-effecting tools:

- `mottbot_local_note_create`: creates a new `.md` or `.txt` draft note under an approved local-write root
- `mottbot_local_doc_append`: appends plain text to an existing `.md` or `.txt` document under an approved local-write root
- `mottbot_local_doc_replace`: replaces an existing `.md` or `.txt` document only when the supplied SHA-256 matches the current file
- `mottbot_local_command_run`: runs one configured local command in an approved workspace root
- `mottbot_repo_apply_patch`: applies a `git apply` compatible patch in an approved repository root
- `mottbot_local_shell_run`: runs a bounded shell script in an approved workspace root when `tools.localExec.allowedCommands` includes `shell`
- `mottbot_code_execution_run`: runs bounded JavaScript through Node when `tools.localExec.allowedCommands` includes `node`
- `mottbot_web_fetch`: fetches bounded text from a public HTTP(S) URL
- `mottbot_web_search`: performs a bounded public web search
- `mottbot_browser_snapshot`: fetches a public page and extracts title/text metadata
- `mottbot_canvas_create`: writes a local HTML artifact under `data/tool-canvas`
- `mottbot_subagent_codex_start`: starts a Codex CLI subagent job through the existing Codex job boundary
- `mottbot_automation_task_create`: writes a local automation task artifact under `data/tool-automation`
- `mottbot_gateway_webhook_post`: POSTs a bounded JSON object to a public webhook URL
- `mottbot_media_artifact_create`: writes a local media-generation request artifact under `data/tool-media`
- `mottbot_codex_job_start`: starts a `codex exec --json` job in an approved project repository using the Codex CLI job settings
- `mottbot_codex_job_cancel`: cancels a running Codex CLI job started by this process
- `mottbot_mcp_call_tool`: calls one allowlisted tool on one configured MCP stdio server
- `mottbot_github_issue_create`: creates a GitHub issue through `gh`
- `mottbot_github_issue_comment`: comments on a GitHub issue through `gh`
- `mottbot_github_pr_comment`: comments on a GitHub pull request through `gh`
- `mottbot_ms_todo_task_create`: creates a Microsoft To Do task through Microsoft Graph
- `mottbot_ms_todo_task_update`: modifies a Microsoft To Do task through Microsoft Graph
- `mottbot_telegram_send_message`: sends plain text to the current Telegram chat or a configured approved target
- `mottbot_restart_service`: schedules a delayed local launchd restart and is exposed only for admin callers
- `mottbot_telegram_react`: adds or clears a Telegram emoji reaction and is exposed only for admin callers

Local write tools are scoped by:

```json
{
  "tools": {
    "localWrite": {
      "roots": ["./data/tool-notes"],
      "deniedPaths": [],
      "maxWriteBytes": 20000
    }
  }
}
```

Local write roots are created when the service starts. Local document tools reject path traversal and symlink escapes, allow only `.md` and `.txt`, and keep writes approval-gated. The note tool is create-only. The replace tool requires a SHA-256 from `mottbot_local_doc_read`, so a file changed after review cannot be overwritten by stale model output. Write tool output returns path, size, and checksums, not the written content.

Local command execution is scoped by:

```json
{
  "tools": {
    "localExec": {
      "roots": ["./data/tool-workspace"],
      "deniedPaths": [],
      "allowedCommands": [],
      "timeoutMs": 5000,
      "maxOutputBytes": 40000
    }
  }
}
```

Leave `tools.localExec.allowedCommands` empty until you intentionally approve commands. Commands run without shell expansion, with ignored stdin, bounded stdout/stderr, timeout enforcement, a minimal environment, and a working directory under `tools.localExec.roots`. Shells and privilege-changing commands are denied even if they appear in the allowlist.

Codex CLI job tools use the `codexJobs` configuration block:

- `codexJobs.repoRoots` controls which git checkout roots can run Codex jobs
- `codexJobs.artifactRoot` stores stdout, stderr, JSONL events, and final messages
- `codexJobs.codex.command`, `coderProfile`, and `defaultTimeoutMs` control the CLI command, default profile, and timeout cap
- `mottbot_codex_job_status` and `mottbot_codex_job_tail` are read-only admin tools
- direct tool job state is kept in memory for the current process

MCP stdio tool calls are scoped by:

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

Each MCP server entry must name the executable and the exact MCP tools Mottbot may call. The bridge starts a fresh stdio server per approved call, performs initialize plus one `tools/call`, bounds output, and denies unconfigured servers, unallowlisted MCP tools, shells, and privilege-changing commands. Remote MCP servers and long-lived MCP sessions are not implemented.

Telegram send tools are scoped by:

```json
{
  "tools": {
    "telegramSend": {
      "allowedChatIds": []
    }
  }
}
```

When the target is omitted, `mottbot_telegram_send_message` sends to the current chat and current topic thread. Sending to any other chat requires that chat ID or username in `tools.telegramSend.allowedChatIds`.

Optional per-tool policy:

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

Policy fields are `allowedRoles`, `allowedChatIds`, `requiresApproval`, `dryRun`, and `maxOutputBytes`. Owner/admin-only tool definitions remain owner/admin-only even if policy config attempts to expose them to trusted or normal users. Side-effecting tools always require approval for real execution; `requiresApproval:false` is ignored for write-capable tools.

Approval flow:

1. The model requests a side-effecting tool call and receives an approval-required denial with a sanitized preview.
2. An owner/admin taps the inline approve button, or approves the latest pending request for the current session:

   ```text
   /tool approve mottbot_local_note_create approved draft note
   ```

3. Button approval edits the source message, removes the stale keyboard, and starts a continuation run in the same session.
4. When transcript state still contains the pending call, continuation executes the exact stored tool call and appends its result before asking the model to respond.
5. If the stored call is unavailable, the bot falls back to a continuation prompt and the next matching model tool call in that session consumes the approval.
6. The bot records audit rows in SQLite.
7. The matching tool call executes once and consumes the approval.

The inline deny button records `operator_denied`, edits the source message, removes the keyboard, and does not continue the run. Stale pending buttons record `approval_expired` and do not create a reusable approval.

If an approval was created from a pending preview, the approval is bound to that request fingerprint and cannot be reused for different arguments.

Useful commands:

- `/help`
- `/commands`
- `/tool status`
- `/tool help`
- `/tools`
- `/tool approve <tool-name> <reason>`
- `/tool revoke <tool-name>`
- `/tool audit [limit] [here] [tool:<name>] [code:<decision>]`
- `/runs [limit] [here]` lists recent runs for owner/admin callers; add `here` to filter to the current session
- `/debug [summary|service|runs|errors|logs|config]` shows owner/admin diagnostics
- `/help` and `/commands` show commands available to the current caller after role, chat type, enabled feature, and per-chat command policy filtering
- `/tool status` shows the model-exposed tool declarations for the caller, enabled host tools, and active approvals for the current session
- `/tool help` and `/tools` explain tool commands for the current caller after command policy filtering
- `/tool audit` lists bounded recent tool policy and approval decisions for owner/admin callers
- `/remember <fact>` stores approved long-term memory for the current session
- `/remember scope:personal <fact>` stores approved user-scoped memory when the current Telegram user ID is available
- `/remember scope:chat <fact>` stores approved chat-scoped memory for the current chat
- `/remember scope:group <fact>` stores approved group-scoped memory when the route is not a private DM
- `/remember scope:project:<key> <fact>` stores approved project-scoped memory under the supplied project key; the memory is visible when the current `agents.bindings` route has the same `projectKey`
- `/memory` lists approved memory that applies to the current route
- `/memory candidates [pending|accepted|rejected|archived|all]` lists model-proposed memory candidates for review and includes inline accept, reject, and archive buttons for pending candidates
- `/memory accept <candidate-id-prefix>` approves a pending candidate and stores it as accepted memory
- `/memory reject <candidate-id-prefix>` rejects a pending candidate
- `/memory edit <candidate-id-prefix> <replacement fact>` edits candidate text before approval
- `/memory pin|unpin <memory-id-prefix>` changes prompt precedence for accepted memory
- `/memory archive <memory-id-prefix>` hides accepted memory without deleting its row
- `/memory archive candidate <candidate-id-prefix>` archives a pending candidate
- `/memory clear candidates` deletes pending candidates for the current session
- `/forget <memory-id-prefix|all|auto>` removes one matching visible memory, all active memory visible to the current route, or active automatic summaries visible to the current route
- `/usage [daily|monthly]` shows local run counts by global/chat/session/user/model and configured limits

Optional automatic session summaries are deterministic and disabled by default. Model-assisted memory candidates are also disabled by default. By default they require explicit approval before they appear in prompts; set `candidateApprovalPolicy` to `auto` to accept low-sensitivity candidates automatically while leaving more sensitive candidates pending:

```json
{
  "memory": {
    "autoSummariesEnabled": true,
    "autoSummaryRecentMessages": 12,
    "autoSummaryMaxChars": 1000,
    "candidateExtractionEnabled": true,
    "extractionProvider": "lmstudio",
    "preResponseExtractionEnabled": true,
    "preResponseExtractionTimeoutMs": 1500,
    "postResponseExtractionEnabled": true,
    "postResponseExtractionAsync": true,
    "postResponseExtractionTimeoutMs": 10000,
    "candidateRecentMessages": 12,
    "candidateMaxPerRun": 5,
    "candidateApprovalPolicy": "auto",
    "autoAcceptMaxSensitivity": "low",
    "lmStudio": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "model": "your-loaded-model-id",
      "timeoutMs": 5000,
      "maxTokens": 800,
      "temperature": 0
    }
  }
}
```

Automatic summaries are tagged separately from explicit `/remember` entries and can be removed with `/forget auto`. Memory candidates store the proposed scope, reason, source message IDs, and sensitivity classification so the operator can approve, edit, reject, or archive pending entries before use. Keep `autoAcceptMaxSensitivity` at `low` unless the deployment is comfortable storing more personal facts without review.

When `extractionProvider="lmstudio"`, Mottbot calls LM Studio's local OpenAI-compatible chat completions endpoint. Pre-response extraction can make newly accepted memory available to the immediate model response. Async post-response extraction reflects on the completed turn without delaying the Telegram reply. If LM Studio is unavailable, slow, or returns malformed JSON, the chat run continues and the extraction failure is logged.

Large local reasoning models can be slow and may return structured JSON in LM Studio's `reasoning_content` field instead of `message.content`. Mottbot accepts either field. Increase `preResponseExtractionTimeoutMs`, `postResponseExtractionTimeoutMs`, and `lmStudio.timeoutMs` when using larger local models.

## Persistent macOS Service

Use `SETUP.md` for the full host-local service runbook.

The supported persistent local setup is a macOS user LaunchAgent:

- label: `ai.mottbot.bot`
- plist: `~/Library/LaunchAgents/ai.mottbot.bot.plist`
- logs: `~/Library/Logs/mottbot/`
- command: absolute Node binary plus `node_modules/tsx/dist/cli.mjs src/index.ts start`

Service install and restart probe candidate Node binaries before writing the plist. The selected Node must be able to load the repo's native `better-sqlite3` binding, which prevents launchd from recording a Node binary with an incompatible ABI. To force a specific runtime, set `MOTTBOT_SERVICE_NODE_PATH` to the absolute Node binary before running service commands.

Common commands:

```bash
export MOTTBOT_SERVICE_NODE_PATH=/Users/mottbot/.local/share/fnm/node-versions/v24.13.1/installation/bin/node
corepack pnpm service install --start
corepack pnpm service status
corepack pnpm run restart
corepack pnpm service stop
```

Automatic host sync is available as a separate LaunchAgent:

- label: `ai.mottbot.sync-main`
- plist: `~/Library/LaunchAgents/ai.mottbot.sync-main.plist`
- logs: `~/Library/Logs/mottbot/sync-main.out.log` and `~/Library/Logs/mottbot/sync-main.err.log`
- interval: 300 seconds by default

The sync helper only fast-forwards a clean checkout from `origin/main`. It refuses dirty worktrees and non-fast-forward history, then runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm health`, and a service restart with `MOTTBOT_SERVICE_NODE_PATH`.

Common commands:

```bash
corepack pnpm run sync:service
corepack pnpm run sync:service:install
corepack pnpm run sync:service:status
corepack pnpm run sync:service:uninstall
```

Set `MOTTBOT_AUTO_SYNC_INTERVAL_SECONDS`, `MOTTBOT_AUTO_SYNC_LABEL`, `MOTTBOT_AUTO_SYNC_REMOTE`, `MOTTBOT_AUTO_SYNC_BRANCH`, or `MOTTBOT_AUTO_SYNC_SERVICE_LABEL` before install/run to override the defaults.

Runtime secrets remain in the configured local config file and delegated token environment variables, not in the LaunchAgent plist.

Polling conflict behavior:

- Telegram permits only one active `getUpdates` consumer per bot token.
- If a second consumer exists, Mottbot logs the conflict and retries every 30 seconds instead of exiting.
- The bot still cannot receive updates until the other poller stops or the token is rotated.

## Migration Operations

`mottbot db migrate` applies ordered SQL migrations and records them in `schema_migrations`.

Current behavior:

- `0001_initial.sql` is the baseline schema migration
- migrations are idempotent and safe to run repeatedly
- an existing migration row with a different checksum stops startup instead of continuing with an unknown schema state
- unversioned databases that already have the current tables are bootstrapped into the migration ledger without dropping rows

Backup before migration:

1. Run `corepack pnpm backup create`.
2. Validate the new backup with `corepack pnpm backup validate <backup-dir>`.
3. Run `corepack pnpm db migrate`.
4. Start or restart the bot and run `corepack pnpm health`.

Rollback expectation:

- stop the bot
- restore the database file and matching `-wal` and `-shm` files from the same backup point
- start the bot again

Do not hand-edit rows in `schema_migrations`. If a checksum mismatch appears, treat it as a migration-file integrity problem and inspect the local diff before retrying.

## Backup And Restore Operations

Create a host-local backup:

```bash
corepack pnpm backup create
```

The backup command creates a timestamped directory under `data/backups/` unless `--dest <dir>` is provided. It writes a consistent SQLite online backup, copies source WAL/SHM sidecars when present, writes a redacted config snapshot, and records file sizes plus SHA-256 checksums in `manifest.json`.

`.env` is excluded by default because it can contain delegated access tokens and host-local overrides. Use `--include-env` only for private host-local backups:

```bash
corepack pnpm backup create --include-env
```

Validate a backup:

```bash
corepack pnpm backup validate data/backups/<backup-dir>
```

Run a restore dry-run check against the configured database path:

```bash
corepack pnpm backup validate data/backups/<backup-dir> --target-sqlite data/mottbot.sqlite
```

Restore checklist:

1. Stop launchd: `corepack pnpm service stop`.
2. Validate the backup and target path.
3. Move the existing SQLite database plus `-wal` and `-shm` sidecars aside.
4. Copy `mottbot.sqlite` from the backup into the configured `storage.sqlitePath`.
5. Recreate `.env` separately unless the backup intentionally included it.
6. Run `corepack pnpm db migrate`.
7. Restart: `corepack pnpm service start`.
8. Confirm `corepack pnpm health` is healthy.

Do not restore over a running service. The validator warns when the target database already exists so the operator can plan downtime and an explicit replacement.

## Log Rotation Operations

Inspect launchd log sizes:

```bash
corepack pnpm logs status
```

Archive logs:

```bash
corepack pnpm logs rotate
```

Archive, truncate active log files, and retain only the latest ten archives:

```bash
corepack pnpm logs rotate --truncate --max-archives 10
```

Archives are written below `~/Library/Logs/mottbot/archive/` by default. Missing logs are recorded as skipped. Symlinks are also skipped so the command does not truncate an unexpected target.

## Data Retention Operations

`mottbot db prune` removes old operational rows without touching auth profiles or session routes. It also prunes old archived session-memory rows and old rejected or archived memory candidates.

Default behavior is a dry run:

```bash
pnpm db:prune
```

To delete rows older than a chosen age:

```bash
tsx src/index.ts db prune --older-than-days 30 --yes
```

Retention safety rules:

- `queued`, `starting`, and `streaming` runs are never pruned
- active approved memories, pending candidates, and accepted candidate audit rows are not pruned
- `active` outbox rows are never pruned
- `queued` and `claimed` queue rows are retained
- completed and failed queue rows can be pruned by age
- terminal runs are pruned only after old child outbox, bot-message, and transcript rows are safe to remove
- processed Telegram update IDs are pruned by `processed_at`, which means very old duplicate updates can be accepted again
- session routes and auth profiles are not pruned by this command

Back up the SQLite file before running destructive pruning on a production host.

## Attachment Operations

Attachment settings:

- `attachments.cacheDir`
- `attachments.maxFileBytes`
- `attachments.maxTotalBytes`
- `attachments.maxPerMessage`
- `attachments.maxExtractedTextCharsPerFile`
- `attachments.maxExtractedTextCharsTotal`
- `attachments.csvPreviewRows`
- `attachments.csvPreviewColumns`
- `attachments.pdfMaxPages`

Runtime behavior:

- supported images are downloaded from Telegram only when the selected model accepts image input
- downloaded attachment bytes are capped by both `attachments.maxFileBytes` and the per-message `attachments.maxTotalBytes` budget
- downloaded bytes are converted into native image blocks for the model request
- text, Markdown, code, CSV, TSV, and PDF documents are downloaded within byte limits and converted into bounded prompt-only text
- CSV and TSV files are summarized as table previews
- encrypted, unreadable, or scanned PDFs are recorded as extraction failures in attachment metadata
- other non-image attachments are preserved as text metadata
- cache files are deleted after model request construction or failure cleanup
- current Pi AI payload support used by the repo exposes text and image blocks only, so PDFs, office files, audio, video, stickers, and animations are not passed as native provider file blocks
- raw extracted file text is sent only to the active model run and is not stored in SQLite

Telegram commands:

- `/files` lists recent file metadata for the current session
- `/files forget <id-prefix>` removes one retained file record and strips its transcript attachment metadata
- `/files clear` removes all retained file records for the current session and strips attachment metadata from transcript JSON

Keep the attachment cache under `data/` or another ignored local path. Do not point it at a committed directory.

## Tool Operations

Model tool execution is enabled only for registry-approved read-only tools plus explicitly enabled side-effecting tools.

Current tool set:

- `mottbot_health_snapshot`: returns a token-free runtime health snapshot
- `mottbot_service_status`, `mottbot_recent_runs`, `mottbot_recent_errors`, and `mottbot_recent_logs`: admin-only operator diagnostics
- `mottbot_repo_list_files`, `mottbot_repo_read_file`, `mottbot_repo_search`, `mottbot_git_status`, `mottbot_git_branch`, `mottbot_git_recent_commits`, and `mottbot_git_diff`: admin-only local repository inspection
- `mottbot_github_repo`, `mottbot_github_open_prs`, `mottbot_github_recent_issues`, `mottbot_github_ci_status`, and `mottbot_github_workflow_failures`: admin-only GitHub read inspection through `gh`
- `mottbot_ms_todo_lists`, `mottbot_ms_todo_tasks`, and `mottbot_ms_todo_task_get`: admin-only Microsoft To Do read inspection through Microsoft Graph
- `mottbot_google_drive_search` and `mottbot_google_drive_get_file`: admin-only Google Drive read inspection through Google APIs
- `mottbot_local_doc_read`: admin-only bounded local document read plus edit checksum
- `mottbot_local_note_create`, `mottbot_local_doc_append`, `mottbot_local_doc_replace`, `mottbot_local_command_run`, `mottbot_mcp_call_tool`, `mottbot_github_issue_create`, `mottbot_github_issue_comment`, `mottbot_github_pr_comment`, `mottbot_ms_todo_task_create`, `mottbot_ms_todo_task_update`, `mottbot_telegram_send_message`, `mottbot_restart_service`, and `mottbot_telegram_react`: optional side-effecting tools requiring host opt-in and one-shot approval

Runtime controls:

- unknown, disabled, and invalid tools are denied by the registry
- side-effecting tools are disabled unless explicitly enabled and guarded by policy and one-shot approval
- each tool definition has a timeout and output-size limit
- each run is limited to three tool rounds and five tool calls
- repository tools resolve real paths, reject traversal/symlink escapes, deny secret and generated paths by default, and return bounded output
- local document tools stay under local-write roots, allow only `.md` and `.txt`, and reject stale full replacements by SHA-256
- local command tools require an allowlisted command and approved cwd, run without shell expansion, and return bounded stdout/stderr
- MCP calls require a configured stdio server and per-server MCP tool allowlist
- GitHub tools require host `gh` auth, accept only `owner/name` repository identifiers, return bounded sanitized summaries, and keep issue/comment writes approval-bound
- Telegram shows short status edits while a tool is prepared, running, completed, or failed
- tool call and result metadata is persisted in transcript rows with role `tool`

Approval-backed side-effect implementations currently cover local note/document writes, local command execution, configured MCP stdio calls, GitHub issue/comment writes, Telegram send/reaction, and delayed service restart. Do not add generic network, broader GitHub writes, or secret-adjacent tools without extending approval persistence, audit retention, tests, and operator runbooks.

## Operator Safety Limits

Ingress safety settings:

- `behavior.maxInboundTextChars`
- `attachments.maxPerMessage`
- `attachments.maxFileBytes`
- `attachments.maxTotalBytes`

Rejected messages receive a Telegram reply explaining the limit. They are recorded as processed updates, but they do not create runs, transcript rows, or queued work.

## Live Smoke Operations

Use `docs/live-smoke-tests.md` for external integration validation.

Local preflight:

```bash
pnpm smoke:preflight
```

The command validates a configured live environment immediately when run.

Preflight checks:

- configuration and required secrets can be loaded
- Telegram `getMe` accepts the configured bot token
- SQLite migrations apply cleanly
- the default auth profile is present
- admin IDs are configured
- webhook mode has a public URL when polling is disabled
- health counters and migration versions can be read without printing tokens

Suite dry run:

```bash
pnpm smoke:suite --dry-run
```

Suite execution:

```bash
pnpm smoke:suite
```

The suite runs preflight and, when user-account credentials are configured, private conversation, `/health`, `/usage`, reply-to-latest-bot-message, optional group mention, and optional attachment fixture checks.

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

Runtime controls are exposed through Telegram commands:

- `/status`
- `/usage [daily|monthly]`
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

Command authorization:

- owner/admin roles can run commands in any chat
- non-operator users can run commands only in private chats unless chat governance explicitly allows a group command
- if `telegram.allowedChatIds` is non-empty, non-operator private commands must come from a listed chat
- non-operator group and supergroup commands are rejected before creating or mutating a session route unless a chat policy allows the command
- `/users` commands manage additional database-backed roles and per-chat policy

Command validation:

- `/model` accepts only known built-in Codex model refs
- `/profile <profile_id>` requires an existing profile ID with a safe command-line shape
- `/bind [name]` accepts at most 64 visible characters

## Failure Handling

Current behavior:

- auth refresh failures bubble up as run failures
- stream errors are shown in chat as `Run failed: ...`
- active run cancellation marks the run `cancelled`
- WebSocket transport failures can fall back to SSE automatically
- outbox finalize or fail paths send a fresh message if editing the placeholder fails
- queued runs accepted before a restart are resumed when session and transcript context still exist
- unrecoverable queued runs are marked failed and the chat is notified when possible
- interrupted `starting` and `streaming` runs are still marked failed on restart

Current limitation:

- durable queue recovery is single-process only and is not safe for active multi-replica execution

## Logging

The app uses structured logging through pino.

Useful log events today:

- bot startup
- rejected Telegram updates
- token refresh events
- queued run, run start, run completion, and run failure with safe run/session/chat fields
- transport fallback warnings
- run execution failures
- Telegram edit failures
- attachment download or cleanup failures

Health output includes:

- queued runs
- active runs
- interrupted runs
- stale active outbox messages
- degraded transport sessions
- processed Telegram updates

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

- richer transcript summarization
- migration discipline for future schema changes
