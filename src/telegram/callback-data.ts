/** Parsed Telegram callback action for inline approval buttons. */
export type TelegramCallbackAction =
  | { type: "project_approve"; approvalId: string }
  | { type: "tool_approve"; auditId: string }
  | { type: "tool_deny"; auditId: string };

const PREFIX = "mb";
const PROJECT_APPROVE = "pa";
const TOOL_APPROVE = "ta";
const TOOL_DENY = "td";
const CALLBACK_DATA_MAX_BYTES = 64;

function assertCallbackDataFits(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Telegram callback data is too long.");
  }
  return data;
}

/** Builds compact callback data for approving a Project Mode approval request. */
export function buildProjectApprovalCallbackData(approvalId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${PROJECT_APPROVE}:${approvalId}`);
}

/** Builds compact callback data for approving a tool side-effect request. */
export function buildToolApprovalCallbackData(auditId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${TOOL_APPROVE}:${auditId}`);
}

/** Builds compact callback data for denying a tool side-effect request. */
export function buildToolDenyCallbackData(auditId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${TOOL_DENY}:${auditId}`);
}

/** Parses Mottbot callback data into a supported inline Telegram action. */
export function parseTelegramCallbackData(data: string): TelegramCallbackAction | undefined {
  const [prefix, action, ...rest] = data.split(":");
  const id = rest.join(":").trim();
  if (prefix !== PREFIX || !id) {
    return undefined;
  }
  if (action === PROJECT_APPROVE) {
    return { type: "project_approve", approvalId: id };
  }
  if (action === TOOL_APPROVE) {
    return { type: "tool_approve", auditId: id };
  }
  if (action === TOOL_DENY) {
    return { type: "tool_deny", auditId: id };
  }
  return undefined;
}
