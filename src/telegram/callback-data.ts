/** Parsed Telegram callback action for inline approval buttons. */
type TelegramCallbackAction =
  | { type: "run_stop"; runId: string }
  | { type: "run_retry"; runId: string }
  | { type: "run_new"; runId: string }
  | { type: "run_usage"; runId: string }
  | { type: "run_files"; runId: string }
  | { type: "tool_approve"; auditId: string }
  | { type: "tool_deny"; auditId: string }
  | { type: "memory_accept"; candidateId: string }
  | { type: "memory_reject"; candidateId: string }
  | { type: "memory_archive"; candidateId: string };

const PREFIX = "mb";
const RUN_STOP = "rs";
const RUN_RETRY = "rr";
const RUN_NEW = "rn";
const RUN_USAGE = "ru";
const RUN_FILES = "rf";
const TOOL_APPROVE = "ta";
const TOOL_DENY = "td";
const MEMORY_ACCEPT = "ma";
const MEMORY_REJECT = "mr";
const MEMORY_ARCHIVE = "mh";
const CALLBACK_DATA_MAX_BYTES = 64;

function assertCallbackDataFits(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Telegram callback data is too long.");
  }
  return data;
}

/** Builds compact callback data for stopping the active run from its status message. */
export function buildRunStopCallbackData(runId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${RUN_STOP}:${runId}`);
}

/** Builds compact callback data for retrying a failed run from its status message. */
export function buildRunRetryCallbackData(runId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${RUN_RETRY}:${runId}`);
}

/** Builds compact callback data for clearing the current session from a completed run. */
export function buildRunNewCallbackData(runId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${RUN_NEW}:${runId}`);
}

/** Builds compact callback data for showing usage from a completed run. */
export function buildRunUsageCallbackData(runId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${RUN_USAGE}:${runId}`);
}

/** Builds compact callback data for showing retained files from a completed run. */
export function buildRunFilesCallbackData(runId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${RUN_FILES}:${runId}`);
}

/** Builds compact callback data for approving a tool side-effect request. */
export function buildToolApprovalCallbackData(auditId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${TOOL_APPROVE}:${auditId}`);
}

/** Builds compact callback data for denying a tool side-effect request. */
export function buildToolDenyCallbackData(auditId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${TOOL_DENY}:${auditId}`);
}

/** Builds compact callback data for accepting a memory candidate. */
export function buildMemoryCandidateAcceptCallbackData(candidateId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${MEMORY_ACCEPT}:${candidateId}`);
}

/** Builds compact callback data for rejecting a memory candidate. */
export function buildMemoryCandidateRejectCallbackData(candidateId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${MEMORY_REJECT}:${candidateId}`);
}

/** Builds compact callback data for archiving a memory candidate. */
export function buildMemoryCandidateArchiveCallbackData(candidateId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${MEMORY_ARCHIVE}:${candidateId}`);
}

/** Parses Mottbot callback data into a supported inline Telegram action. */
export function parseTelegramCallbackData(data: string): TelegramCallbackAction | undefined {
  const [prefix, action, ...rest] = data.split(":");
  const id = rest.join(":").trim();
  if (prefix !== PREFIX || !id) {
    return undefined;
  }
  if (action === RUN_STOP) {
    return { type: "run_stop", runId: id };
  }
  if (action === RUN_RETRY) {
    return { type: "run_retry", runId: id };
  }
  if (action === RUN_NEW) {
    return { type: "run_new", runId: id };
  }
  if (action === RUN_USAGE) {
    return { type: "run_usage", runId: id };
  }
  if (action === RUN_FILES) {
    return { type: "run_files", runId: id };
  }
  if (action === TOOL_APPROVE) {
    return { type: "tool_approve", auditId: id };
  }
  if (action === TOOL_DENY) {
    return { type: "tool_deny", auditId: id };
  }
  if (action === MEMORY_ACCEPT) {
    return { type: "memory_accept", candidateId: id };
  }
  if (action === MEMORY_REJECT) {
    return { type: "memory_reject", candidateId: id };
  }
  if (action === MEMORY_ARCHIVE) {
    return { type: "memory_archive", candidateId: id };
  }
  return undefined;
}
