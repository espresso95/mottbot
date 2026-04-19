# Release Notes

## Unreleased

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
