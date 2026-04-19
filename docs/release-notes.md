# Release Notes

## Unreleased

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
