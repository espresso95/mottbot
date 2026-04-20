# Release Notes

## Unreleased

### Named Agents And Route Bindings

- Added config-defined named agents with profile, model, fast mode, and optional system prompt defaults.
- Added `MOTTBOT_AGENTS_JSON` for deploying agent presets and Telegram route bindings from the environment.
- Added Telegram route bindings by chat ID, thread ID, chat type, and user ID.
- Added `agent_id` to persisted session routes so newly created routes record which agent selected their defaults.
- Added `/agent list`, `/agent show`, `/agent set`, and `/agent reset`; set/reset are owner/admin-only.
- Added agent `toolNames` and `toolPolicies` so selected agents can further restrict model-visible and executable tools.
- Added run-time model governance for persisted agent models before model transport.
- Added agent `maxConcurrentRuns` and `maxQueuedRuns` for host-local active-run and backlog control.
- Added `agent_id` to run records for agent-level queue accounting.
- Added `/debug agents` and dashboard runtime agent summaries for route counts, run counts, limits, and stale persisted agent IDs.
- Added a read-only dashboard Agents panel that renders those summaries without requiring raw JSON inspection.

Operator checklist:

- Keep the default synthesized `main` agent if you only need one bot personality.
- Use bindings for durable chat or topic defaults instead of changing global model/profile defaults.
- Treat config changes as defaults for new routes; existing routes keep their persisted route-local settings.
- Keep chat governance and usage budgets aligned with any agent that uses a different model.
- Use `/agent set <id>` to move an existing session to a configured agent after validating that the target profile exists.
- Use agent tool restrictions only to narrow the global tool policy; they cannot make side-effecting tools approval-free.
- Use `maxQueuedRuns:0` to temporarily pause accepting new work for an agent while still keeping the agent configured.

### Guarded Tool Expansion

- Added admin-only `mottbot_local_doc_read` for bounded `.md` and `.txt` reads under approved local-write roots, including SHA-256 output for safe edits.
- Added approval-gated `mottbot_local_doc_append` and `mottbot_local_doc_replace` for approved local documents; replacements require the current SHA-256 to match.
- Added approval-gated `mottbot_local_command_run` for allowlisted commands inside approved workspace roots without shell expansion.
- Added approval-gated `mottbot_mcp_call_tool` for one allowlisted tool call on one configured MCP stdio server.
- Added approval-gated `mottbot_github_issue_create`, `mottbot_github_issue_comment`, and `mottbot_github_pr_comment` through the host GitHub CLI.
- Added `pnpm smoke:github-write` for explicitly confirmed disposable GitHub write validation through the real tool approval path.
- Added `MOTTBOT_LOCAL_EXEC_*` and `MOTTBOT_MCP_SERVERS_JSON` configuration.
- Added `pnpm smoke:local-tools` for disposable local validation of document edits, command execution, and MCP stdio calls through the real approval path.

Operator checklist:

- Keep `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false` until you are ready for model-requested side effects.
- Set `MOTTBOT_LOCAL_WRITE_ROOTS` to a disposable document directory before testing append or replace.
- Leave `MOTTBOT_LOCAL_EXEC_ALLOWED_COMMANDS` empty until you intentionally approve specific commands.
- Configure MCP servers with explicit `allowedTools`; do not point the bridge at broad or destructive tool servers for first validation.
- Validate GitHub writes against a disposable repository or disposable issue/PR before using them on real project work.
- Start GitHub write validation with `MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN=true pnpm smoke:github-write`; live writes require `MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM=create-live-github-issue`.
- Run `pnpm smoke:local-tools` before live Telegram approval tests.
- Use `/tool audit here` after approval tests to confirm previews, approvals, and execution decisions.

### Command Discovery

- Added `/commands` as an alias for `/help`.
- Updated `/help` and `/tool help` so governed group chats only list commands the caller can actually run.
- Kept command discovery filtered by caller role, chat type, enabled runtime features, and per-chat command policy.
- Added command-router tests for policy-filtered general help and tool help.

### Native File Attachment Plumbing

- Added internal native file attachment input plumbing and model capability checks.
- Kept native file input disabled for the current Codex provider adapter because the installed provider boundary supports text and images only.
- Added a transport fallback so accidental file blocks become safe text notices instead of image payloads.
- Restricted dormant native file preparation to classified document types so unknown binary documents are not treated as provider file blocks when a future adapter enables file input.
- Added tests proving native file preparation is capability-gated and raw file bytes are not passed through the current provider context.

Operator checklist:

- Continue relying on bounded text extraction for PDF, text, Markdown, code, CSV, and TSV files.
- Use `pnpm smoke:suite` attachment fixtures to validate live fallback behavior.
- Do not expect native provider file blocks until the provider adapter exposes a real file content type.

### Live Validation Automation

- Added `pnpm smoke:suite` as a guarded live validation matrix.
- Added `MOTTBOT_LIVE_VALIDATION_ENABLED` and dry-run/planning controls.
- The suite composes preflight, private conversation, `/health`, `/usage`, reply, optional group mention, and optional attachment fixture checks.
- Suite output is token-free JSON with bounded child output for failed checks.

Operator checklist:

- Run `MOTTBOT_LIVE_VALIDATION_ENABLED=true MOTTBOT_LIVE_VALIDATION_DRY_RUN=true pnpm smoke:suite` before sending live messages.
- Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `MOTTBOT_LIVE_BOT_USERNAME` to include user-account scenarios.
- Set `MOTTBOT_LIVE_VALIDATION_GROUP_TARGET` and `MOTTBOT_LIVE_VALIDATION_FILE_PATHS` only for controlled test chats and fixtures.

### Model And Cost Controls

- Added local UTC daily/monthly run budgets for global, per-user, per-chat, per-session, and per-model scopes.
- Added `MOTTBOT_USAGE_BUDGETS_JSON` and `MOTTBOT_USAGE_WARNING_THRESHOLD_PERCENT`.
- Added `/usage [daily|monthly]` for local run counts and configured limits.
- Runs denied by budget fail before auth/model transport and are recorded with `usage_budget_denied` without consuming the same budget.
- Budget warnings are shown in the run status message when the next run reaches the configured warning threshold.
- Budgets use local accepted-run counters, not provider billing or delayed subscription usage payloads.

Operator checklist:

- Leave `MOTTBOT_USAGE_BUDGETS_JSON` empty for unlimited local use.
- Start with a soft cap such as `{"dailyRunsPerUser":25,"dailyRunsPerChat":100}` for trusted chats.
- Use `/usage` after live validation to confirm counts and configured limits.

### Multi-User Roles And Chat Governance

- Added persistent Telegram owner/admin/trusted roles, with `MOTTBOT_ADMIN_USER_IDS` treated as protected owners.
- Added `telegram_user_roles`, `telegram_chat_policies`, and `telegram_governance_audit` tables.
- Added `/users me`, `/users list`, `/users grant`, `/users revoke`, `/users audit`, and `/users chat show|set|clear`.
- Added per-chat policy for allowed roles, group command permissions, allowed models, allowed model tools, memory scopes, and stricter attachment limits.
- Model tool declarations are filtered by per-chat policy and tool execution rechecks the same chat policy before handlers run.
- `/model`, `/remember`, and memory candidate acceptance now honor chat governance policy when configured.

Operator checklist:

- Confirm your bootstrap owner with `/users me`.
- Grant a second operator before broad rollout with `/users grant <user-id> admin <reason>`.
- Use `/users chat set <chat-id> <json>` to limit group use for trusted users.
- Use `/users audit` after role or chat-policy changes to confirm the expected audit rows.

### Write-Capable Approved Tools

- Added admin-only `mottbot_local_note_create` for create-only `.md` and `.txt` draft notes under approved local-write roots.
- Added admin-only `mottbot_telegram_send_message` for plain-text Telegram sends to the current chat or configured approved targets.
- Added `MOTTBOT_LOCAL_WRITE_*` and `MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS` configuration.
- Expanded side-effect classes for local write, network write, Telegram send, GitHub write, process control, and secret-adjacent tools.
- Real side-effect execution now always requires a one-shot request-bound approval; `dryRun:true` remains the preview-only path.

Operator checklist:

- Keep `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=false` until you want model-initiated writes.
- Set `MOTTBOT_LOCAL_WRITE_ROOTS` to a disposable notes directory for first validation.
- Leave `MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS` empty unless cross-chat sends are intentionally approved.
- Test by asking the bot to create one draft note, inspect the approval preview, approve it, then verify the created file.

### Backup And Log Operations

- Added `mottbot backup create` for timestamped local backups with SQLite online backup, optional source sidecars, redacted config, manifest checksums, and optional `.env` inclusion.
- Added `mottbot backup validate` for checksum and SQLite integrity checks plus restore target warnings.
- Added `mottbot logs status` and `mottbot logs rotate` for launchd log size inspection, archive, optional truncation, and archive retention.
- Added log-size visibility to diagnostics output.

Operator checklist:

- Run `corepack pnpm backup create` before migrations, pruning, or high-risk host maintenance.
- Keep `.env` excluded unless the backup will remain private on the same trusted host.
- Use `corepack pnpm logs rotate --truncate --max-archives 10` when launchd logs grow too large.

### Model-Assisted Memory

- Added opt-in post-run memory candidate extraction with `MOTTBOT_MEMORY_CANDIDATES_ENABLED`.
- Added a separate `memory_candidates` review queue with scope, reason, source message IDs, sensitivity, status, and accepted-memory linkage.
- Added scoped approved memory for session, personal, chat, group, and explicit project keys.
- Added `/memory candidates`, `/memory accept`, `/memory reject`, `/memory edit`, `/memory pin`, `/memory unpin`, `/memory archive`, `/memory archive candidate`, and `/memory clear candidates`.
- Prompt construction now includes only approved, unarchived scoped memory and gives pinned memory precedence over automatic summaries.

Operator checklist:

- Leave `MOTTBOT_MEMORY_CANDIDATES_ENABLED=false` until you want the model to propose reviewable memories after completed runs.
- Use `/memory candidates` to inspect proposals and `/memory accept <id-prefix>` only after reviewing sensitive or long-lived facts.
- Use `/memory archive <id-prefix>` or `/memory unpin <id-prefix>` to remove prompt influence without deleting the original row.

### Operator Dashboard

- Added dashboard API panels for runtime health, service status, recent runs, recent failures, and bounded logs.
- Added tool visibility, active approval, audit, and session memory panels.
- Added validated session memory add/edit/delete endpoints.
- Added delayed service restart control that requires a configured dashboard auth token and explicit `restart` confirmation.
- Redacts token-like strings from dashboard log, memory, approval, audit, and run-summary output.

Operator checklist:

- Keep the dashboard bound to loopback unless `MOTTBOT_DASHBOARD_AUTH_TOKEN` is configured.
- Set `MOTTBOT_DASHBOARD_AUTH_TOKEN` before using dashboard service restart controls.
- Use the runtime, logs, tools, and memory panels from `http://127.0.0.1:8787/dashboard` when `MOTTBOT_DASHBOARD_ENABLED=true`.

### Read-Only GitHub Integration

- Added admin-only GitHub read tools backed by the host GitHub CLI.
- Added bounded repository metadata, open pull request, open issue, CI run, and failed workflow summaries.
- Added `/github` and `/gh` admin commands for direct repository, pull request, issue, run, and failure status.
- Added `tools.github` config and `MOTTBOT_GITHUB_*` environment variables.
- Kept GitHub auth in `gh`; Mottbot does not store GitHub tokens.

Operator checklist:

- Run `gh auth login` on the host account that runs the service.
- Optionally set `MOTTBOT_GITHUB_REPOSITORY=owner/name`; otherwise confirm local `origin` points at GitHub.
- Use `/github status` from an admin chat to verify metadata, open work, and latest CI.
- Use `/github failures` after pushes to inspect recent failed workflow runs.

### Read-Only Local Repository Tools

- Added admin-only model tools for approved local repository inspection.
- Added bounded file listing, file reading, literal text search, git status, current branch lookup, recent commits, and git diff summaries.
- Added repository root and denied-path config through `tools.repository` and `MOTTBOT_REPOSITORY_*`.
- Denied common secret and generated paths by default, including `.env`, config files, auth files, `.git`, `node_modules`, `data`, `dist`, `coverage`, database files, logs, and Telegram session files.
- Rejected path traversal and symlink escapes through realpath checks.

Operator checklist:

- Keep `MOTTBOT_REPOSITORY_ROOTS=.` for the current checkout, or set a comma-separated list of approved roots.
- Add project-specific private directories to `MOTTBOT_REPOSITORY_DENIED_PATHS`.
- Ask from an admin chat for repo status, a bounded file read, and a search term to live-validate the tools.

### Tool Permission Model

- Added per-tool policy overrides through `tools.policies` and `MOTTBOT_TOOL_POLICIES_JSON`.
- Filtered model-exposed tool declarations by caller role and chat before each run.
- Rechecked policy at execution time before any handler runs.
- Added sanitized approval previews with request fingerprints for side-effecting tools.
- Bound `/tool approve` to the latest pending preview in the current session when one exists.
- Added `/tool audit [limit] [here] [tool:<name>] [code:<decision>]` for bounded admin audit inspection.

Operator checklist:

- Run `corepack pnpm db:migrate` or restart the service so migration `0005_tool_policy_previews` is applied.
- Leave `MOTTBOT_TOOL_POLICIES_JSON` empty for conservative defaults.
- After a side-effecting tool is denied, inspect the preview, then approve with `/tool approve <tool-name> <reason>`.
- Use `/tool audit here` to confirm approval-required, operator-approved, approved, expired, mismatch, or revoked decisions.

### Telegram Reactions

- Added configurable acknowledgement reactions for accepted model-bound messages.
- Added optional reaction update ingestion into session context.
- Added approved admin-only `mottbot_telegram_react` for model-requested Telegram reactions.

Operator checklist:

- Confirm `MOTTBOT_TELEGRAM_REACTIONS_ENABLED=true`.
- Keep `MOTTBOT_TELEGRAM_REACTION_NOTIFICATIONS=own` unless every allowed chat is trusted.
- Use `MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY=true` only if the ack should disappear after each run.
- Run a live private-chat smoke after changing reaction settings.

### General File Understanding

- Added bounded text extraction for text, Markdown, code, CSV, TSV, and selectable-text PDF attachments.
- Added `attachment_records` for retained file metadata and extraction summaries.
- Added `/files`, `/files forget <id-prefix>`, and `/files clear`.
- Kept raw downloaded bytes, raw extracted text, local cache paths, and Telegram file download URLs out of SQLite.

Operator checklist:

- Set file extraction limits in `.env` before real use:
  - `MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE`
  - `MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL`
  - `MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS`
  - `MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS`
  - `MOTTBOT_ATTACHMENT_PDF_MAX_PAGES`
- Run `corepack pnpm db:migrate` or restart the service so migration `0004_attachment_records` is applied.
- Test a `.txt`, `.md`, code file, CSV, selectable-text PDF, unsupported binary, and image in a controlled chat.
- Use `/files` after each test to confirm metadata appears without raw file text.
- Use `/files forget <id-prefix>` and `/files clear` to verify retained metadata can be removed.
