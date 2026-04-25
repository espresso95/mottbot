import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { TranscriptAttachmentMetadata } from "../telegram/attachments.js";

export type AttachmentRecord = {
  id: string;
  sessionKey: string;
  runId?: string;
  telegramMessageId?: number;
  kind: string;
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  ingestionStatus: string;
  ingestionReason?: string;
  downloadedBytes?: number;
  extractionKind?: string;
  extractionStatus?: string;
  extractionReason?: string;
  extractedTextChars?: number;
  promptTextChars?: number;
  extractionTruncated?: boolean;
  language?: string;
  rowCount?: number;
  columnCount?: number;
  pageCount?: number;
  createdAt: number;
  updatedAt: number;
};

type AttachmentRecordRow = {
  id: string;
  session_key: string;
  run_id: string | null;
  telegram_message_id: number | null;
  kind: string;
  file_id: string;
  file_unique_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  ingestion_status: string;
  ingestion_reason: string | null;
  downloaded_bytes: number | null;
  extraction_kind: string | null;
  extraction_status: string | null;
  extraction_reason: string | null;
  extracted_text_chars: number | null;
  prompt_text_chars: number | null;
  extraction_truncated: number | null;
  language: string | null;
  row_count: number | null;
  column_count: number | null;
  page_count: number | null;
  created_at: number;
  updated_at: number;
};

function mapRow(row: AttachmentRecordRow): AttachmentRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.telegram_message_id !== null ? { telegramMessageId: row.telegram_message_id } : {}),
    kind: row.kind,
    fileId: row.file_id,
    ...(row.file_unique_id ? { fileUniqueId: row.file_unique_id } : {}),
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.file_size !== null ? { fileSize: row.file_size } : {}),
    ingestionStatus: row.ingestion_status,
    ...(row.ingestion_reason ? { ingestionReason: row.ingestion_reason } : {}),
    ...(row.downloaded_bytes !== null ? { downloadedBytes: row.downloaded_bytes } : {}),
    ...(row.extraction_kind ? { extractionKind: row.extraction_kind } : {}),
    ...(row.extraction_status ? { extractionStatus: row.extraction_status } : {}),
    ...(row.extraction_reason ? { extractionReason: row.extraction_reason } : {}),
    ...(row.extracted_text_chars !== null ? { extractedTextChars: row.extracted_text_chars } : {}),
    ...(row.prompt_text_chars !== null ? { promptTextChars: row.prompt_text_chars } : {}),
    ...(row.extraction_truncated !== null ? { extractionTruncated: row.extraction_truncated === 1 } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.row_count !== null ? { rowCount: row.row_count } : {}),
    ...(row.column_count !== null ? { columnCount: row.column_count } : {}),
    ...(row.page_count !== null ? { pageCount: row.page_count } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AttachmentRecordStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  addMany(params: {
    sessionKey: string;
    runId: string;
    telegramMessageId?: number;
    attachments: TranscriptAttachmentMetadata[];
  }): AttachmentRecord[] {
    const now = this.clock.now();
    const insert = this.database.db.prepare(
      `insert into attachment_records (
        id, session_key, run_id, telegram_message_id, kind, file_id, file_unique_id, file_name, mime_type,
        file_size, ingestion_status, ingestion_reason, downloaded_bytes, extraction_kind, extraction_status,
        extraction_reason, extracted_text_chars, prompt_text_chars, extraction_truncated, language,
        row_count, column_count, page_count, created_at, updated_at
      ) values (
        @id, @session_key, @run_id, @telegram_message_id, @kind, @file_id, @file_unique_id, @file_name, @mime_type,
        @file_size, @ingestion_status, @ingestion_reason, @downloaded_bytes, @extraction_kind, @extraction_status,
        @extraction_reason, @extracted_text_chars, @prompt_text_chars, @extraction_truncated, @language,
        @row_count, @column_count, @page_count, @created_at, @updated_at
      )
      on conflict(id) do update set
        ingestion_status = excluded.ingestion_status,
        ingestion_reason = excluded.ingestion_reason,
        downloaded_bytes = excluded.downloaded_bytes,
        extraction_kind = excluded.extraction_kind,
        extraction_status = excluded.extraction_status,
        extraction_reason = excluded.extraction_reason,
        extracted_text_chars = excluded.extracted_text_chars,
        prompt_text_chars = excluded.prompt_text_chars,
        extraction_truncated = excluded.extraction_truncated,
        language = excluded.language,
        row_count = excluded.row_count,
        column_count = excluded.column_count,
        page_count = excluded.page_count,
        updated_at = excluded.updated_at`,
    );
    const records = params.attachments.map((attachment) => ({
      id: attachment.recordId ?? createId(),
      session_key: params.sessionKey,
      run_id: params.runId,
      telegram_message_id: params.telegramMessageId ?? null,
      kind: attachment.kind,
      file_id: attachment.fileId,
      file_unique_id: attachment.fileUniqueId ?? null,
      file_name: attachment.fileName ?? null,
      mime_type: attachment.mimeType ?? null,
      file_size: attachment.fileSize ?? null,
      ingestion_status: attachment.ingestionStatus,
      ingestion_reason: attachment.ingestionReason ?? null,
      downloaded_bytes: attachment.downloadedBytes ?? null,
      extraction_kind: attachment.extraction?.kind ?? null,
      extraction_status: attachment.extraction?.status ?? null,
      extraction_reason: attachment.extraction?.reason ?? null,
      extracted_text_chars: attachment.extraction?.textChars ?? null,
      prompt_text_chars: attachment.extraction?.promptChars ?? null,
      extraction_truncated:
        attachment.extraction?.truncated === undefined ? null : attachment.extraction.truncated ? 1 : 0,
      language: attachment.extraction?.language ?? null,
      row_count: attachment.extraction?.rowCount ?? null,
      column_count: attachment.extraction?.columnCount ?? null,
      page_count: attachment.extraction?.pageCount ?? null,
      created_at: now,
      updated_at: now,
    }));
    const save = this.database.db.transaction(() => {
      for (const record of records) {
        insert.run(record);
      }
    });
    save();
    return this.listRecent(params.sessionKey, records.length).filter((record) =>
      records.some((saved) => saved.id === record.id),
    );
  }

  listRecent(sessionKey: string, limit = 10): AttachmentRecord[] {
    const rows = this.database.db
      .prepare<
        unknown[],
        AttachmentRecordRow
      >("select * from attachment_records where session_key = ? order by created_at desc limit ?")
      .all(sessionKey, limit);
    return rows.map(mapRow);
  }

  findByIdPrefix(sessionKey: string, idPrefix: string): AttachmentRecord[] {
    const rows = this.database.db
      .prepare<
        unknown[],
        AttachmentRecordRow
      >("select * from attachment_records where session_key = ? and id like ? order by created_at desc limit 2")
      .all(sessionKey, `${idPrefix}%`);
    return rows.map(mapRow);
  }

  remove(sessionKey: string, id: string): number {
    return this.database.db
      .prepare("delete from attachment_records where session_key = ? and id = ?")
      .run(sessionKey, id).changes;
  }

  clearSession(sessionKey: string): number {
    return this.database.db.prepare("delete from attachment_records where session_key = ?").run(sessionKey).changes;
  }
}
