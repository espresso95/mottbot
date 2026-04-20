# Release Notes

## Unreleased

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
