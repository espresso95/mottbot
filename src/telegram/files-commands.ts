import type { Api } from "grammy";
import type { AttachmentRecordStore } from "../sessions/attachment-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { SessionRoute } from "../sessions/types.js";
import { formatAttachmentRecord } from "./command-formatters.js";
import { normalizeSingleArg } from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram file metadata command handler. */
export type FilesCommandDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
  args: string[];
  attachments?: AttachmentRecordStore;
  transcripts: TranscriptStore;
};

/** Handles /files list, forget, and clear subcommands. */
export async function handleFilesCommand(params: FilesCommandDependencies): Promise<void> {
  const { api, event, session, args, attachments, transcripts } = params;
  if (!attachments) {
    await sendReply(api, event, "File metadata is not available.");
    return;
  }
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "list") {
    const limit = Number(args[1] ?? 10);
    const records = attachments.listRecent(session.sessionKey, Number.isInteger(limit) ? limit : 10);
    await sendReply(
      api,
      event,
      records.length > 0
        ? ["Recent files:", ...records.map(formatAttachmentRecord)].join("\n")
        : "No files recorded for this session.",
    );
    return;
  }
  if (sub === "clear" || (sub === "forget" && args[1]?.toLowerCase() === "all")) {
    const removed = attachments.clearSession(session.sessionKey);
    const transcriptRows = transcripts.removeAttachmentMetadata({ sessionKey: session.sessionKey });
    await sendReply(api, event, `Forgot ${removed} file records and updated ${transcriptRows} transcript messages.`);
    return;
  }
  if (sub === "forget") {
    const prefix = normalizeSingleArg(args[1]);
    if (!prefix) {
      await sendReply(api, event, "Usage: /files forget <file-id-prefix|all>");
      return;
    }
    const matches = attachments.findByIdPrefix(session.sessionKey, prefix);
    if (matches.length === 0) {
      await sendReply(api, event, "No matching file record found.");
      return;
    }
    if (matches.length > 1) {
      await sendReply(api, event, "File ID prefix is ambiguous. Use more characters from /files.");
      return;
    }
    const record = matches[0]!;
    const removed = attachments.remove(session.sessionKey, record.id);
    const transcriptRows = transcripts.removeAttachmentMetadata({
      sessionKey: session.sessionKey,
      runId: record.runId,
      recordId: record.id,
    });
    await sendReply(
      api,
      event,
      removed > 0
        ? `Forgot file ${record.id.slice(0, 8)} and updated ${transcriptRows} transcript messages.`
        : "No matching file record found.",
    );
    return;
  }
  await sendReply(api, event, "Usage: /files [list [limit]] | /files forget <file-id-prefix|all> | /files clear");
}
